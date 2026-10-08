import type { Clock } from '../../platform/clock.js';
import { isDuplicateKey, withTransaction } from '../../platform/db.js';
import type { Db, ResultSetHeader, RowDataPacket } from '../../platform/db.js';
import type { Redis } from '../../platform/redis.js';
import { STREAM_KEY } from './producer.js';
import { rollUp } from './rollup.js';
import { telemetryEventSchema } from './schema.js';
import type { TelemetryEvent } from './schema.js';

export const GROUP = 'rollup';

// prune stops after this many DELETE passes in one call, so one call never runs unbounded.
export const MAX_PRUNE_PASSES = 50;

export interface StreamEntry {
  id: string;
  event: TelemetryEvent | null; // null when the payload is missing or invalid
}

export interface ProcessResult {
  applied: number;
  duplicates: number;
  malformed: number;
}

export interface WorkerDeps {
  redis: Redis;
  db: Db;
  consumer: string;
  clock: Clock;
  batchSize?: number;
  blockMs?: number;
  claimIdleMs?: number;
  pruneBatchSize?: number; // rows per DELETE pass in prune (default 10000)
}

export interface TelemetryWorker {
  ensureGroup(): Promise<void>;
  readNew(): Promise<StreamEntry[]>;
  reclaim(): Promise<StreamEntry[]>;
  process(entries: StreamEntry[]): Promise<ProcessResult>;
  runOnce(): Promise<ProcessResult>;
  prune(olderThanMs?: number): Promise<number>;
  pending(): Promise<number>;
}

function decode(payload: unknown): TelemetryEvent | null {
  if (typeof payload !== 'string') return null;
  try {
    const parsed = telemetryEventSchema.safeParse(JSON.parse(payload));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// [[id, [field, value, ...]], ...] as returned inside XREADGROUP and XAUTOCLAIM replies. Every
// entry with an id is kept, a bad payload as a null event, so it can still be acked.
export function parseEntries(raw: unknown): StreamEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item: unknown): StreamEntry[] => {
    if (!Array.isArray(item) || typeof item[0] !== 'string') return [];
    const fields: unknown[] = Array.isArray(item[1]) ? (item[1] as unknown[]) : [];
    let payload: unknown;
    for (let i = 0; i + 1 < fields.length; i += 2) if (fields[i] === 'e') payload = fields[i + 1];
    return [{ id: item[0], event: decode(payload) }];
  });
}

export function parseReadGroupReply(reply: unknown): StreamEntry[] {
  if (!Array.isArray(reply)) return [];
  return reply.flatMap((stream: unknown) => (Array.isArray(stream) ? parseEntries(stream[1]) : []));
}

const STREAM_ID = /^(\d+)-(\d+)$/;

// Stream ids ("<ms>-<seq>") in stream order. Every worker inserts processed ids in this one order,
// so two transactions holding overlapping ids always meet at the lowest shared id first and one
// simply waits for the other instead of the two waiting on each other.
export function compareStreamIds(a: string, b: string): number {
  const ma = STREAM_ID.exec(a);
  const mb = STREAM_ID.exec(b);
  if (!ma || !mb) return a < b ? -1 : a > b ? 1 : 0;
  const ms = BigInt(ma[1] ?? 0) - BigInt(mb[1] ?? 0);
  const diff = ms !== 0n ? ms : BigInt(ma[2] ?? 0) - BigInt(mb[2] ?? 0);
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}

const isNoGroup = (error: unknown) => error instanceof Error && error.message.startsWith('NOGROUP');

// Telemetry is at-least-once end to end: the producer's XADDs are not atomic with the request, and
// the stream redelivers anything not acked. The worker makes the counts exact for redelivered
// stream entries. It reads with a consumer group, rolls each batch into minute buckets, records
// every entry id in the same MySQL transaction, and only then XACKs. A crash between commit and
// ack means redelivery, and the recorded ids turn that redelivery into a no-op.
export function createTelemetryWorker(deps: WorkerDeps): TelemetryWorker {
  const { redis, db, consumer, clock } = deps;
  const batchSize = deps.batchSize ?? 200;
  const blockMs = deps.blockMs ?? 5_000;
  const claimIdleMs = deps.claimIdleMs ?? 60_000;
  const pruneBatchSize = deps.pruneBatchSize ?? 10_000;

  async function ensureGroup(): Promise<void> {
    try {
      await redis.xgroup('CREATE', STREAM_KEY, GROUP, '0', 'MKSTREAM');
    } catch (error) {
      if (!(error instanceof Error && error.message.startsWith('BUSYGROUP'))) throw error;
    }
  }

  // If the stream or its group vanished (a flush, a failover to an empty replica), make them again
  // and carry on instead of crash looping.
  async function withGroup<T>(fallback: T, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (!isNoGroup(error)) throw error;
      await ensureGroup();
      return fallback;
    }
  }

  // One transaction: a plain consistent read of the ids already done (never FOR UPDATE, S4-F2),
  // then the new ids and the rollup rows. Returns how many entries were newly applied.
  const applyBatch = (valid: readonly (readonly [string, TelemetryEvent])[]): Promise<number> =>
    withTransaction(db, async (conn) => {
      const [seenRows] = await conn.query<RowDataPacket[]>('SELECT entry_id FROM telemetry_processed WHERE entry_id IN (?)', [valid.map(([id]) => id)]);
      const seen = new Set(seenRows.map((row) => String(row.entry_id)));
      const fresh = valid.filter(([id]) => !seen.has(id));
      if (fresh.length === 0) return 0;
      const now = new Date(clock.now());
      await conn.query('INSERT INTO telemetry_processed (entry_id, processed_at) VALUES ?', [fresh.map(([id]) => [id, now])]);
      const rows = rollUp(fresh.map(([, event]) => event));
      await conn.query(
        'INSERT INTO telemetry_rollups (metric, bucket_start, dims_hash, dims, event_count, value_sum) VALUES ? AS new ON DUPLICATE KEY UPDATE event_count = telemetry_rollups.event_count + new.event_count, value_sum = telemetry_rollups.value_sum + new.value_sum',
        [rows.map((row) => [row.metric, new Date(row.bucketStart), row.dimsHash, JSON.stringify(row.dims), row.count, row.sum])],
      );
      return fresh.length;
    });

  async function process(entries: StreamEntry[]): Promise<ProcessResult> {
    if (entries.length === 0) return { applied: 0, duplicates: 0, malformed: 0 };
    const byId = new Map<string, TelemetryEvent>();
    let validCount = 0;
    for (const entry of entries) {
      if (entry.event === null) continue;
      validCount += 1;
      byId.set(entry.id, entry.event);
    }
    const valid = [...byId].sort(([a], [b]) => compareStreamIds(a, b));
    let applied = 0;
    if (valid.length > 0) {
      try {
        applied = await applyBatch(valid);
      } catch (error) {
        // Another worker committed some of these ids after this transaction read them. The rerun
        // sees them and counts them as duplicates. A second failure propagates and nothing is
        // acked, so the batch comes back later through XAUTOCLAIM.
        if (!isDuplicateKey(error)) throw error;
        applied = await applyBatch(valid);
      }
    }
    // Only after the commit. Malformed entries are acked too, so one poison entry can never block
    // the group.
    await redis.xack(STREAM_KEY, GROUP, ...new Set(entries.map((entry) => entry.id)));
    return { applied, duplicates: validCount - applied, malformed: entries.length - validCount };
  }

  const readNew = (): Promise<StreamEntry[]> =>
    withGroup([], async () =>
      parseReadGroupReply(await redis.xreadgroup('GROUP', GROUP, consumer, 'COUNT', batchSize, 'BLOCK', blockMs, 'STREAMS', STREAM_KEY, '>')),
    );

  // XAUTOCLAIM hands this consumer any entry another consumer read but never acked within claimIdleMs.
  const reclaim = (): Promise<StreamEntry[]> =>
    withGroup([], async () => {
      const reply = await redis.xautoclaim(STREAM_KEY, GROUP, consumer, claimIdleMs, '0-0', 'COUNT', batchSize);
      return Array.isArray(reply) ? parseEntries(reply[1]) : [];
    });

  // Deletes in passes of pruneBatchSize until a pass removes fewer, at most MAX_PRUNE_PASSES passes
  // (S4-F3). Returns the total removed.
  async function prune(olderThanMs = 24 * 60 * 60_000): Promise<number> {
    const cutoff = new Date(clock.now() - olderThanMs);
    let total = 0;
    for (let pass = 0; pass < MAX_PRUNE_PASSES; pass += 1) {
      const [result] = await db.query<ResultSetHeader>('DELETE FROM telemetry_processed WHERE processed_at < ? ORDER BY processed_at LIMIT ?', [
        cutoff,
        pruneBatchSize,
      ]);
      total += result.affectedRows;
      if (result.affectedRows < pruneBatchSize) break;
    }
    return total;
  }

  return {
    ensureGroup,
    readNew,
    reclaim,
    process,
    async runOnce() {
      const claimed = await reclaim();
      const fresh = await readNew();
      return process([...claimed, ...fresh]);
    },
    prune,
    pending: () =>
      withGroup(0, async () => {
        const summary = await redis.xpending(STREAM_KEY, GROUP);
        return Array.isArray(summary) ? Number(summary[0] ?? 0) : 0;
      }),
  };
}
