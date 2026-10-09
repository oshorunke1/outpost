import type { Clock } from '../../platform/clock.js';
import { isDuplicateKey, withTransaction } from '../../platform/db.js';
import type { Db, ResultSetHeader, RowDataPacket, TransactionLogger } from '../../platform/db.js';
import { recordWorkerRun } from '../../platform/metrics.js';
import type { Metrics } from '../../platform/metrics.js';
import type { Redis } from '../../platform/redis.js';
import { STREAM_KEY } from './producer.js';
import { rollUp } from './rollup.js';
import { telemetryEventSchema } from './schema.js';
import type { TelemetryEvent } from './schema.js';

export const GROUP = 'rollup';

// prune stops after this many DELETE passes in one call, so one call never runs unbounded.
export const MAX_PRUNE_PASSES = 50;

// Tries in all (the first plus two reruns) when the processed-id insert hits ER_DUP_ENTRY (S4-F2).
export const DUP_ATTEMPTS = 3;

// The last millisecond a MySQL DATETIME can hold (9999-12-31 23:59:59.999 UTC). An event past it
// passes the schema but MySQL refuses its bucket_start, and that refusal would fail every batch
// it lands in, so decode treats it as malformed. The bound is static, never the worker's clock, so
// an old redelivery still applies.
export const MAX_STORABLE_TS = Date.UTC(10000, 0, 1) - 1;

// A reclaimed entry handed out this many times is tried on its own, and dead-lettered (acked and
// counted, with a log line) if MySQL refuses it as data (I1).
export const MAX_DELIVERIES = 5;

export interface StreamEntry {
  id: string;
  event: TelemetryEvent | null; // null when the payload is missing or invalid
  deliveries?: number; // set by reclaim: how many times the group has handed this entry out
}

export interface ProcessResult {
  applied: number;
  duplicates: number;
  malformed: number;
  deadLettered: number; // the dead_letter result: acked without being applied, see MAX_DELIVERIES
}

export interface WorkerDeps {
  redis: Redis;
  db: Db;
  consumer: string;
  clock: Clock;
  logger: TransactionLogger; // told about failed reclaimed batches, dead letters and failed commits
  batchSize?: number;
  blockMs?: number;
  claimIdleMs?: number;
  pruneBatchSize?: number; // rows per DELETE pass in prune (default 10000)
  metrics?: Metrics; // when set, runOnce counts entries by result and sampleStream sets the gauges
}

export interface TelemetryWorker {
  ensureGroup(): Promise<void>;
  readNew(): Promise<StreamEntry[]>;
  reclaim(): Promise<StreamEntry[]>;
  process(entries: StreamEntry[]): Promise<ProcessResult>;
  runOnce(): Promise<ProcessResult>;
  prune(olderThanMs?: number): Promise<number>;
  pending(): Promise<number>;
  // XLEN and XPENDING in one go, for the length and pending gauges. Task 20's loop calls it.
  sampleStream(): Promise<{ length: number; pending: number }>;
}

function decode(payload: unknown): TelemetryEvent | null {
  if (typeof payload !== 'string') return null;
  try {
    const parsed = telemetryEventSchema.safeParse(JSON.parse(payload));
    return parsed.success && parsed.data.ts <= MAX_STORABLE_TS ? parsed.data : null;
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

// MySQL refused the data itself (SQLSTATE class 22, a data exception such as a value it cannot
// store). Trying again can never succeed. A lock or duplicate-key race, a read-only failover or a
// dropped connection is not one of these, so an outage never dead-letters anything.
function isDataRejection(error: unknown): boolean {
  const sqlState = typeof error === 'object' && error !== null ? (error as { sqlState?: unknown }).sqlState : undefined;
  return typeof sqlState === 'string' && sqlState.startsWith('22');
}

function errorFields(error: unknown): { err: string; code?: string } {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return { err: error instanceof Error ? error.message : String(error), ...(typeof code === 'string' ? { code } : {}) };
}

const empty = (): ProcessResult => ({ applied: 0, duplicates: 0, malformed: 0, deadLettered: 0 });

function addInto(total: ProcessResult, part: ProcessResult): void {
  total.applied += part.applied;
  total.duplicates += part.duplicates;
  total.malformed += part.malformed;
  total.deadLettered += part.deadLettered;
}

const isNoGroup = (error: unknown) => error instanceof Error && error.message.startsWith('NOGROUP');

// Telemetry is at-least-once end to end: the producer's XADDs are not atomic with the request, and
// the stream redelivers anything not acked. The worker makes the counts exact for redelivered
// stream entries. It reads with a consumer group, rolls each batch into minute buckets, records
// every entry id in the same MySQL transaction, and only then XACKs. A crash between commit and
// ack means redelivery, and the recorded ids turn that redelivery into a no-op.
//
// Reclaimed entries and new reads go through separate transactions, so a reclaimed batch that
// keeps failing never holds back new data. An entry that keeps coming back is dead-lettered once
// it has been handed out MAX_DELIVERIES times and MySQL refuses it on its own.
//
// Known limit (M1, documented for Task 33): processed ids are pruned after 24 hours. An entry
// that was committed but never acked and stays pending longer than that (every worker down for a
// day) would be counted again when it is finally redelivered.
export function createTelemetryWorker(deps: WorkerDeps): TelemetryWorker {
  const { redis, db, consumer, clock, logger } = deps;
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
    }, { logger });

  async function process(entries: StreamEntry[]): Promise<ProcessResult> {
    if (entries.length === 0) return empty();
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
      // ER_DUP_ENTRY means another worker committed some of these ids after this transaction read
      // them. Each rerun is a fresh transaction that sees them and counts them as duplicates, so
      // the fresh set only shrinks. After DUP_ATTEMPTS tries the error propagates, nothing is
      // acked, and the batch comes back later through XAUTOCLAIM.
      for (let attempt = 1; ; attempt += 1) {
        try {
          applied = await applyBatch(valid);
          break;
        } catch (error) {
          if (!isDuplicateKey(error) || attempt >= DUP_ATTEMPTS) throw error;
        }
      }
    }
    // Only after the commit. Malformed entries are acked too, so one poison entry can never block
    // the group.
    await redis.xack(STREAM_KEY, GROUP, ...new Set(entries.map((entry) => entry.id)));
    return { applied, duplicates: validCount - applied, malformed: entries.length - validCount, deadLettered: 0 };
  }

  const readNew = (): Promise<StreamEntry[]> =>
    withGroup([], async () =>
      parseReadGroupReply(await redis.xreadgroup('GROUP', GROUP, consumer, 'COUNT', batchSize, 'BLOCK', blockMs, 'STREAMS', STREAM_KEY, '>')),
    );

  // XAUTOCLAIM hands this consumer any entry another consumer read but never acked within claimIdleMs.
  const reclaim = (): Promise<StreamEntry[]> =>
    withGroup([], async () => {
      const reply = await redis.xautoclaim(STREAM_KEY, GROUP, consumer, claimIdleMs, '0-0', 'COUNT', batchSize);
      return withDeliveries(Array.isArray(reply) ? parseEntries(reply[1]) : []);
    });

  // XAUTOCLAIM does not report delivery counts, so one XPENDING over the claimed id range reads
  // them (XAUTOCLAIM has already counted this delivery).
  async function withDeliveries(entries: StreamEntry[]): Promise<StreamEntry[]> {
    if (entries.length === 0) return entries;
    const ids = entries.map((entry) => entry.id).sort(compareStreamIds);
    const reply: unknown = await redis.xpending(STREAM_KEY, GROUP, ids[0] ?? '-', ids.at(-1) ?? '+', batchSize * 2, consumer);
    const counts = new Map<string, number>();
    if (Array.isArray(reply)) {
      for (const row of reply as unknown[]) if (Array.isArray(row) && typeof row[0] === 'string') counts.set(row[0], Number(row[3]));
    }
    return entries.map((entry) => {
      const deliveries = counts.get(entry.id);
      return deliveries === undefined ? entry : { ...entry, deliveries };
    });
  }

  // Entries handed out MAX_DELIVERIES times are tried one at a time, so good entries that were
  // stuck in a batch with a poison entry still apply; the poison is acked as a dead letter. The rest
  // go through as one batch. Counts land in total as they happen, so a later throw keeps them.
  async function processClaimed(entries: StreamEntry[], total: ProcessResult): Promise<void> {
    const tired = entries.filter((entry) => (entry.deliveries ?? 0) >= MAX_DELIVERIES);
    for (const entry of tired) {
      try {
        addInto(total, await process([entry]));
      } catch (error) {
        if (!isDataRejection(error)) throw error;
        await redis.xack(STREAM_KEY, GROUP, entry.id);
        total.deadLettered += 1;
        logger.error({ entryId: entry.id, deliveries: entry.deliveries, ...errorFields(error) }, 'telemetry entry dead_letter: MySQL refused it after repeated deliveries, so it was acked and dropped');
      }
    }
    addInto(total, await process(entries.filter((entry) => (entry.deliveries ?? 0) < MAX_DELIVERIES)));
  }

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

  const pending = (): Promise<number> =>
    withGroup(0, async () => {
      const summary = await redis.xpending(STREAM_KEY, GROUP);
      return Array.isArray(summary) ? Number(summary[0] ?? 0) : 0;
    });

  return {
    ensureGroup,
    readNew,
    reclaim,
    process,
    async runOnce() {
      const total = empty();
      try {
        const claimed = await reclaim();
        try {
          await processClaimed(claimed, total);
        } catch (error) {
          // They stay pending and come back on a later reclaim; new data goes ahead regardless.
          logger.error({ entries: claimed.length, ...errorFields(error) }, 'reclaimed telemetry batch failed; its entries stay pending');
        }
        addInto(total, await process(await readNew()));
        return total;
      } finally {
        // Counted even when the new read throws, so work already committed is never missed.
        if (deps.metrics) recordWorkerRun(deps.metrics, total);
      }
    },
    prune,
    pending,
    async sampleStream() {
      const [length, pendingCount] = await Promise.all([redis.xlen(STREAM_KEY), pending()]);
      deps.metrics?.streamLength.set(length);
      deps.metrics?.streamPending.set(pendingCount);
      return { length, pending: pendingCount };
    },
  };
}
