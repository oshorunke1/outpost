import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { STREAM_KEY, createRedisTelemetryProducer } from '../../src/modules/telemetry/producer.js';
import { runWorkerLoop } from '../../src/modules/telemetry/runLoop.js';
import { GROUP, IDLE_CONSUMER_MS, createTelemetryWorker } from '../../src/modules/telemetry/worker.js';
import { systemClock } from '../../src/platform/clock.js';
import type { RowDataPacket } from '../../src/platform/db.js';
import { createMetrics } from '../../src/platform/metrics.js';
import { counterValue } from '../support/metrics.js';
import { createIntegrationContext } from './support/context.js';
import type { IntegrationContext } from './support/context.js';

const silent = { info: () => undefined, error: () => undefined };

describe('worker startup and run loop on Redis and MySQL', () => {
  let ctx: IntegrationContext;
  beforeAll(async () => {
    ctx = await createIntegrationContext();
  });
  beforeEach(async () => {
    await ctx.redis.del(STREAM_KEY);
    await ctx.db.query('DELETE FROM telemetry_rollups');
    await ctx.db.query('DELETE FROM telemetry_processed');
  });
  afterAll(async () => {
    await ctx.close();
  });

  const worker = (consumer: string, metrics?: ReturnType<typeof createMetrics>) =>
    createTelemetryWorker({ redis: ctx.redis, db: ctx.db, consumer, clock: systemClock, logger: silent, blockMs: 50, ...(metrics ? { metrics } : {}) });
  const publish = (count: number) =>
    createRedisTelemetryProducer(ctx.redis).publish(
      'game-server',
      Array.from({ length: count }, () => ({ name: 'orb_collected' as const, ts: Date.now(), value: 2 })),
    );
  const consumerNames = async () => {
    const reply = (await ctx.redis.xinfo('CONSUMERS', STREAM_KEY, GROUP)) as unknown[][];
    return reply.map((fields) => String(fields[fields.indexOf('name') + 1])).sort();
  };

  test('startup removes consumers that are idle past the limit with nothing pending, and keeps the rest', async () => {
    const self = worker('self');
    await self.ensureGroup();
    await ctx.redis.xgroup('CREATECONSUMER', STREAM_KEY, GROUP, 'old-idle');
    await publish(1);
    // old-busy reads the entry and never acks it, so it still owns pending work.
    await ctx.redis.xreadgroup('GROUP', GROUP, 'old-busy', 'COUNT', 10, 'STREAMS', STREAM_KEY, '>');
    await sleep(150);
    await ctx.redis.xgroup('CREATECONSUMER', STREAM_KEY, GROUP, 'just-started');

    expect(IDLE_CONSUMER_MS).toBe(60 * 60_000);
    // With the real limit of an hour, nothing here is old enough.
    expect(await self.removeIdleConsumers()).toEqual([]);
    expect(await self.removeIdleConsumers(100)).toEqual(['old-idle']);
    expect(await consumerNames()).toEqual(['just-started', 'old-busy']);
  });

  test('a worker never removes itself, even when it is idle with nothing pending', async () => {
    const self = worker('self');
    await self.ensureGroup();
    await ctx.redis.xgroup('CREATECONSUMER', STREAM_KEY, GROUP, 'self');
    await sleep(60);
    expect(await self.removeIdleConsumers(10)).toEqual([]);
    expect(await consumerNames()).toEqual(['self']);
  });

  test('the loop rolls up what arrives across runs, survives a failed run, samples the stream and stops on abort', async () => {
    const metrics = createMetrics();
    const real = worker('loop', metrics);
    await real.ensureGroup();
    await publish(3);
    const controller = new AbortController();
    let runs = 0;
    const errors: string[] = [];
    await runWorkerLoop({
      worker: {
        prune: () => real.prune(),
        sampleStream: () => real.sampleStream(),
        async runOnce() {
          runs += 1;
          if (runs === 2) throw new Error('blip'); // one failed run in the middle
          const result = await real.runOnce();
          if (runs === 3) await publish(2); // arrives while the loop is running
          if (runs === 5) controller.abort();
          return result;
        },
      },
      logger: { info: () => undefined, error: (_details, message) => void errors.push(message) },
      clock: systemClock,
      signal: controller.signal,
      pruneBatchSize: 1_000,
      sleep: async () => undefined,
    });

    expect(runs).toBe(5);
    expect(errors).toEqual(['telemetry worker run failed, backing off']);
    const [rows] = await ctx.db.query<RowDataPacket[]>("SELECT SUM(event_count) AS n, SUM(value_sum) AS s FROM telemetry_rollups WHERE metric = 'orb_collected'");
    expect({ n: Number(rows[0]?.n), s: Number(rows[0]?.s) }).toEqual({ n: 5, s: 10 });
    expect(await real.pending()).toBe(0);
    expect(await counterValue(metrics.workerEntries, { result: 'applied' })).toBe(5);
    // The first sample ran before any run, while the 3 entries were on the stream.
    expect((await metrics.streamLength.get()).values[0]?.value).toBe(3);
  });
});
