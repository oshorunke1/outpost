import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { STREAM_KEY, createRedisTelemetryProducer } from '../../src/modules/telemetry/producer.js';
import { GROUP, createTelemetryWorker } from '../../src/modules/telemetry/worker.js';
import type { ProcessResult, WorkerDeps } from '../../src/modules/telemetry/worker.js';
import type { Clock } from '../../src/platform/clock.js';
import { systemClock } from '../../src/platform/clock.js';
import { CommitOutcomeUnknownError, isDuplicateKey } from '../../src/platform/db.js';
import type { RowDataPacket } from '../../src/platform/db.js';
import { createIntegrationContext } from './support/context.js';
import type { IntegrationContext } from './support/context.js';
import { beforeQueryDb, failingCommitDb, rejectingQueryDb, spyQueryDb } from './support/failingDb.js';

const DAY_MS = 24 * 60 * 60_000;
const silent = { error: () => undefined };

describe('telemetry worker on Redis and MySQL', () => {
  let ctx: IntegrationContext;
  beforeAll(async () => {
    ctx = await createIntegrationContext();
    // InnoDB only counts deadlocks while this metric is on (same pattern as the ledger tests).
    const [metric] = await ctx.db.query<RowDataPacket[]>("SELECT STATUS FROM information_schema.INNODB_METRICS WHERE NAME = 'lock_deadlocks'");
    if (metric[0]?.STATUS !== 'enabled') await ctx.db.query("SET GLOBAL innodb_monitor_enable = 'lock_deadlocks'");
  });
  beforeEach(async () => {
    await ctx.redis.del(STREAM_KEY);
    await ctx.db.query('DELETE FROM telemetry_rollups');
    await ctx.db.query('DELETE FROM telemetry_processed');
  });
  afterAll(async () => {
    await ctx.close();
  });

  const worker = (consumer: string, options: Partial<WorkerDeps> = {}) =>
    createTelemetryWorker({ redis: ctx.redis, db: ctx.db, consumer, clock: systemClock, logger: silent, blockMs: 50, claimIdleMs: 60_000, ...options });
  const publish = (count: number) =>
    createRedisTelemetryProducer(ctx.redis).publish(
      'game-server',
      Array.from({ length: count }, () => ({ name: 'orb_collected' as const, ts: Date.now(), value: 5 })),
    );
  const totals = async () => {
    const [rows] = await ctx.db.query<RowDataPacket[]>(
      "SELECT COALESCE(SUM(event_count), 0) AS n, COALESCE(SUM(value_sum), 0) AS s FROM telemetry_rollups WHERE metric = 'orb_collected'",
    );
    return { count: Number(rows[0]?.n), sum: Number(rows[0]?.s) };
  };
  const countRows = async (table: 'telemetry_rollups' | 'telemetry_processed') => {
    const [rows] = await ctx.db.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM ??', [table]);
    return Number(rows[0]?.n);
  };
  const deadlocks = async () => {
    const [rows] = await ctx.db.query<RowDataPacket[]>("SELECT COUNT AS n FROM information_schema.INNODB_METRICS WHERE NAME = 'lock_deadlocks' AND STATUS = 'enabled'");
    if (!rows[0]) throw new Error('the lock_deadlocks metric is not enabled');
    return Number(rows[0].n);
  };

  test('rolls a batch up and leaves nothing pending', async () => {
    const a = worker('a');
    await a.ensureGroup();
    await publish(3);
    await expect(a.runOnce()).resolves.toEqual({ applied: 3, duplicates: 0, malformed: 0, deadLettered: 0 });
    expect(await totals()).toEqual({ count: 3, sum: 15 });
    expect(await countRows('telemetry_processed')).toBe(3);
    expect(await a.pending()).toBe(0);
  });

  test('the rollup row stores the minute, the dims and the dims hash', async () => {
    const a = worker('a');
    await a.ensureGroup();
    const ts = Date.UTC(2026, 9, 8, 12, 0, 30);
    await createRedisTelemetryProducer(ctx.redis).publish('game-server', [
      { name: 'purchase_result', ts, dims: { outcome: 'Granted', itemId: 'RedHat' } },
      { name: 'purchase_result', ts: ts + 10_000, dims: { itemId: 'RedHat', outcome: 'Granted' } },
    ]);
    await expect(a.runOnce()).resolves.toEqual({ applied: 2, duplicates: 0, malformed: 0, deadLettered: 0 });
    const [rows] = await ctx.db.query<RowDataPacket[]>('SELECT metric, bucket_start, dims, dims_hash, event_count, value_sum FROM telemetry_rollups');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ metric: 'purchase_result', dims: { itemId: 'RedHat', outcome: 'Granted' }, event_count: 2, value_sum: 0 });
    // The stored text, not a read back through the same pool, so a local-time write cannot pass (M3).
    const [stored] = await ctx.db.query<RowDataPacket[]>("SELECT DATE_FORMAT(bucket_start, '%Y-%m-%d %H:%i:%s') AS t FROM telemetry_rollups");
    expect(stored[0]?.t).toBe('2026-10-08 12:00:00');
    expect(String(rows[0]?.dims_hash)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('redelivered entries are skipped, so at-least-once never double counts', async () => {
    const a = worker('a');
    await a.ensureGroup();
    await publish(2);
    const entries = await a.readNew();
    await a.process(entries);
    await expect(a.process(entries)).resolves.toEqual({ applied: 0, duplicates: 2, malformed: 0, deadLettered: 0 });
    expect(await totals()).toEqual({ count: 2, sum: 10 });
  });

  test('two workers racing on the same entries still count each once', async () => {
    const a = worker('a');
    await a.ensureGroup();
    await publish(4);
    const entries = await a.readNew();
    const results = await Promise.all([a.process(entries), worker('b').process(entries)]);
    expect(results.reduce((n, r) => n + r.applied, 0)).toBe(4);
    expect(results.reduce((n, r) => n + r.duplicates, 0)).toBe(4);
    await expect(a.process(entries)).resolves.toEqual({ applied: 0, duplicates: 4, malformed: 0, deadLettered: 0 });
    expect(await totals()).toEqual({ count: 4, sum: 20 });
  });

  // S4-F2: no FOR UPDATE. Another worker commits the same ids between this transaction's read and
  // its insert, the insert hits ER_DUP_ENTRY, and the rerun counts them as duplicates.
  test('a duplicate key on the processed ids reruns the batch and counts them as duplicates', async () => {
    const a = worker('a');
    await a.ensureGroup();
    await publish(3);
    const entries = await a.readNew();
    const racing = createTelemetryWorker({
      redis: ctx.redis,
      db: beforeQueryDb(ctx.db, /^INSERT INTO telemetry_processed/, async () => {
        await expect(worker('b').process(entries)).resolves.toEqual({ applied: 3, duplicates: 0, malformed: 0, deadLettered: 0 });
      }),
      consumer: 'a',
      clock: systemClock,
      logger: silent,
    });
    await expect(racing.process(entries)).resolves.toEqual({ applied: 0, duplicates: 3, malformed: 0, deadLettered: 0 });
    expect(await totals()).toEqual({ count: 3, sum: 15 });
    expect(await a.pending()).toBe(0);
  });

  // M2: whatever order entries arrive in, processed ids are inserted in stream order.
  test('processed ids are inserted in stream order even when the batch arrives shuffled', async () => {
    const a = worker('a');
    await a.ensureGroup();
    await publish(5);
    const entries = await a.readNew();
    const order = entries.map((entry) => entry.id);
    const shuffled = [entries[3], entries[0], entries[4], entries[2], entries[1]].filter((entry) => entry !== undefined);
    const spy = spyQueryDb(ctx.db, /^INSERT INTO telemetry_processed/);
    await expect(worker('a', { db: spy.db }).process(shuffled)).resolves.toMatchObject({ applied: 5 });
    const [rows] = spy.calls as [unknown[][]][];
    expect(rows?.[0]?.map((row) => row[0])).toEqual(order);
  });

  // R1: each hook commits a processed row for one more of the batch's ids just before this
  // transaction inserts, the way another worker that also holds the entry would.
  const commitProcessed = (id: string) => async () => {
    await ctx.db.query('INSERT INTO telemetry_processed (entry_id, processed_at) VALUES (?, UTC_TIMESTAMP(3))', [id]);
  };
  const collidingWorker = (ids: readonly string[]) =>
    worker('a', { db: beforeQueryDb(ctx.db, /^INSERT INTO telemetry_processed/, ids.map(commitProcessed)) });

  test('two duplicate collisions in a row still succeed on the third attempt with exact totals', async () => {
    const a = worker('a');
    await a.ensureGroup();
    await publish(4);
    const entries = await a.readNew();
    const ids = entries.map((entry) => entry.id);
    await expect(collidingWorker([ids[0] ?? '', ids[1] ?? '']).process(entries)).resolves.toEqual({ applied: 2, duplicates: 2, malformed: 0, deadLettered: 0 });
    expect(await totals()).toEqual({ count: 2, sum: 10 }); // the two committed elsewhere are not counted here
    expect(await countRows('telemetry_processed')).toBe(4);
    expect(await a.pending()).toBe(0);
  });

  test('a third duplicate collision rejects and acks nothing', async () => {
    const a = worker('a');
    await a.ensureGroup();
    await publish(4);
    const entries = await a.readNew();
    const ids = entries.map((entry) => entry.id);
    const error: unknown = await collidingWorker([ids[0] ?? '', ids[1] ?? '', ids[2] ?? '']).process(entries).catch((e: unknown) => e);
    expect(isDuplicateKey(error)).toBe(true);
    expect(await a.pending()).toBe(4);
    expect(await countRows('telemetry_rollups')).toBe(0);
    expect(await countRows('telemetry_processed')).toBe(3); // only the three the other writer committed
  });

  // S4-F9 (a): the ack only ever follows a commit.
  test('a failed transaction acks nothing and writes nothing, so the batch is retried later', async () => {
    const a = worker('a');
    await a.ensureGroup();
    await publish(3);
    const broken = worker('broken', { db: failingCommitDb(ctx.db, 'before-apply'), claimIdleMs: 0 });
    await expect(broken.runOnce()).rejects.toBeInstanceOf(CommitOutcomeUnknownError);
    expect(await a.pending()).toBe(3);
    expect(await countRows('telemetry_rollups')).toBe(0);
    expect(await countRows('telemetry_processed')).toBe(0);
    await expect(worker('rescuer', { claimIdleMs: 0 }).runOnce()).resolves.toEqual({ applied: 3, duplicates: 0, malformed: 0, deadLettered: 0 });
    expect(await totals()).toEqual({ count: 3, sum: 15 });
  });

  test('XAUTOCLAIM recovers entries a dead consumer never acked', async () => {
    const dead = worker('dead');
    await dead.ensureGroup();
    await publish(2);
    expect(await dead.readNew()).toHaveLength(2); // read, then "crash" before processing
    const rescuer = worker('rescuer', { claimIdleMs: 0 });
    await expect(rescuer.runOnce()).resolves.toEqual({ applied: 2, duplicates: 0, malformed: 0, deadLettered: 0 });
    expect(await rescuer.pending()).toBe(0);
  });

  test('an entry idle for less than claimIdleMs is left with its consumer', async () => {
    const slow = worker('slow');
    await slow.ensureGroup();
    await publish(2);
    expect(await slow.readNew()).toHaveLength(2);
    await expect(worker('other').reclaim()).resolves.toEqual([]);
    expect(await slow.pending()).toBe(2);
  });

  test('a malformed entry is acked and counted, not retried forever', async () => {
    const a = worker('a');
    await a.ensureGroup();
    await ctx.redis.xadd(STREAM_KEY, '*', 'e', '{oops');
    // Schema valid, but year 10000 does not fit a DATETIME bucket_start (I1).
    await ctx.redis.xadd(STREAM_KEY, '*', 'e', JSON.stringify({ name: 'orb_collected', ts: 253402300800000, value: 1 }));
    await publish(1);
    await expect(a.runOnce()).resolves.toEqual({ applied: 1, duplicates: 0, malformed: 2, deadLettered: 0 });
    expect(await totals()).toEqual({ count: 1, sum: 5 });
    expect(await a.pending()).toBe(0);
  });

  // I1: a schema-valid entry MySQL refuses. Before its fifth delivery it only fails the reclaimed
  // batch, which runs in its own transaction, so new reads still commit. At five deliveries every
  // reclaimed entry is tried alone; the good ones apply and the poison is acked as a dead letter.
  test('a poison entry never blocks new data and is dead-lettered at five deliveries', async () => {
    const logged: { details: object; message: string }[] = [];
    const logger = { error: (details: object, message: string) => void logged.push({ details, message }) };
    const dead = worker('dead');
    await dead.ensureGroup();
    await createRedisTelemetryProducer(ctx.redis).publish('game-server', [{ name: 'breaker_state', ts: Date.now(), dims: { state: 'Open' } }]);
    await publish(2);
    const [poison] = await dead.readNew(); // delivery 1, then the consumer "crashes"
    const poisonDb = rejectingQueryDb(ctx.db, (sql, values) => sql.startsWith('INSERT INTO telemetry_rollups') && JSON.stringify(values).includes('breaker_state'));
    const rescuer = worker('rescuer', { db: poisonDb, claimIdleMs: 0, logger });
    for (let delivery = 2; delivery <= 4; delivery += 1) {
      await publish(1);
      await expect(rescuer.runOnce()).resolves.toEqual({ applied: 1, duplicates: 0, malformed: 0, deadLettered: 0 });
      expect(await rescuer.pending()).toBe(3);
    }
    await expect(rescuer.runOnce()).resolves.toEqual({ applied: 2, duplicates: 0, malformed: 0, deadLettered: 1 });
    expect(await rescuer.pending()).toBe(0);
    expect(await totals()).toEqual({ count: 5, sum: 25 });
    const [breakerRows] = await ctx.db.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM telemetry_rollups WHERE metric = 'breaker_state'");
    expect(Number(breakerRows[0]?.n)).toBe(0);
    const deadLetters = logged.filter((line) => line.message.includes('dead_letter'));
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]?.details).toMatchObject({ entryId: poison?.id, deliveries: 5, code: 'ER_TRUNCATED_WRONG_VALUE' });
    expect(logged.filter((line) => line.message.includes('reclaimed'))).toHaveLength(3); // the three failed batch tries
  });

  test('a database outage never dead-letters, however many deliveries an entry has', async () => {
    const dead = worker('dead');
    await dead.ensureGroup();
    await publish(1);
    await dead.readNew();
    const down = worker('rescuer', { db: failingCommitDb(ctx.db, 'before-apply'), claimIdleMs: 0 });
    for (let delivery = 2; delivery <= 6; delivery += 1) {
      await expect(down.runOnce()).resolves.toEqual({ applied: 0, duplicates: 0, malformed: 0, deadLettered: 0 });
    }
    expect(await down.pending()).toBe(1);
    await expect(worker('rescuer', { claimIdleMs: 0 }).runOnce()).resolves.toEqual({ applied: 1, duplicates: 0, malformed: 0, deadLettered: 0 });
  });

  test('stream deleted under the worker: it recreates the group and keeps going', async () => {
    const a = worker('a');
    await a.ensureGroup();
    await ctx.redis.del(STREAM_KEY);
    await expect(a.runOnce()).resolves.toEqual({ applied: 0, duplicates: 0, malformed: 0, deadLettered: 0 });
    const groups = (await ctx.redis.xinfo('GROUPS', STREAM_KEY)) as unknown[][];
    expect(groups.map((g) => g[1])).toEqual([GROUP]);
    await publish(1);
    await expect(a.runOnce()).resolves.toMatchObject({ applied: 1 });
  });

  test('ensureGroup twice is fine', async () => {
    const a = worker('a');
    await a.ensureGroup();
    await expect(a.ensureGroup()).resolves.toBeUndefined();
  });

  describe('prune', () => {
    const at = (now: number): Clock => ({ now: () => now });

    test('drops processed ids older than the window', async () => {
      const a = worker('a');
      await a.ensureGroup();
      await publish(1);
      await a.runOnce();
      expect(await a.prune(-1000)).toBe(1);
      expect(await countRows('telemetry_processed')).toBe(0);
    });

    // S4-F9 (d)
    test('a fresh id survives the default 24 hour window, and goes once the window has passed', async () => {
      const start = Date.UTC(2026, 9, 8, 12, 0, 0);
      const a = worker('a', { clock: at(start) });
      await a.ensureGroup();
      await publish(2);
      await a.runOnce();
      // Exactly 24 hours old is still inside the window (strictly older is pruned, M5).
      expect(await worker('a', { clock: at(start + DAY_MS) }).prune()).toBe(0);
      expect(await countRows('telemetry_processed')).toBe(2);
      expect(await worker('a', { clock: at(start + DAY_MS + 1) }).prune()).toBe(2);
      expect(await countRows('telemetry_processed')).toBe(0);
    });

    // S4-F3
    test('removes more than one limit worth in a single call', async () => {
      const a = worker('a', { pruneBatchSize: 2 });
      await a.ensureGroup();
      await publish(5);
      await a.runOnce();
      expect(await a.prune(-1000)).toBe(5);
      expect(await countRows('telemetry_processed')).toBe(0);
    });

    test('stops after 50 passes in one call', async () => {
      const a = worker('a', { pruneBatchSize: 1, batchSize: 100 });
      await a.ensureGroup();
      await publish(53);
      await a.runOnce();
      expect(await a.prune(-1000)).toBe(50);
      expect(await countRows('telemetry_processed')).toBe(3);
    });
  });

  // S4-F2: four workers in one group, two of them reclaiming every pending entry the moment it is
  // read (claimIdleMs 0), so the same ids race through different transactions all the time.
  test('four workers on 2,000 events give exact totals and no deadlocks', async () => {
    const workers = [
      worker('w1', { batchSize: 50, blockMs: 10 }),
      worker('w2', { batchSize: 50, blockMs: 10 }),
      worker('w3', { batchSize: 50, blockMs: 10, claimIdleMs: 0 }),
      worker('w4', { batchSize: 50, blockMs: 10, claimIdleMs: 0 }),
    ];
    await workers[0]?.ensureGroup();
    for (let i = 0; i < 4; i += 1) await publish(500);
    const before = await deadlocks();
    const deadline = Date.now() + 20_000;
    // A run loop's job: if all three tries after ER_DUP_ENTRY collide (other workers kept
    // committing more of the same ids), runOnce rejects, nothing was acked, and the entries come
    // back through XAUTOCLAIM. Any other error fails the test.
    const drain = async (w: (typeof workers)[number]): Promise<ProcessResult> => {
      const sum: ProcessResult = { applied: 0, duplicates: 0, malformed: 0, deadLettered: 0 };
      let idle = 0;
      while (idle < 3 && Date.now() < deadline) {
        const r = await w.runOnce().catch((error: unknown) => {
          if (!isDuplicateKey(error)) throw error;
          return { applied: 0, duplicates: 0, malformed: 0, deadLettered: 0, collided: true };
        });
        if ('collided' in r) {
          idle = 0;
          continue;
        }
        sum.applied += r.applied;
        sum.duplicates += r.duplicates;
        sum.malformed += r.malformed;
        sum.deadLettered += r.deadLettered;
        idle = r.applied + r.duplicates + r.malformed + r.deadLettered === 0 && (await w.pending()) === 0 ? idle + 1 : 0;
      }
      return sum;
    };
    const results = await Promise.all(workers.map(drain));
    const deadlockDelta = (await deadlocks()) - before;
    expect(results.reduce((n, r) => n + r.applied, 0)).toBe(2000);
    expect(results.reduce((n, r) => n + r.malformed + r.deadLettered, 0)).toBe(0);
    expect(results.reduce((n, r) => n + r.duplicates, 0)).toBeGreaterThan(0); // the reclaim race really happened
    expect(await totals()).toEqual({ count: 2000, sum: 10_000 });
    expect(await countRows('telemetry_processed')).toBe(2000);
    expect(await workers[0]?.pending()).toBe(0);
    expect(deadlockDelta).toBe(0);
  });
});
