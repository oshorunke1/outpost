// The telemetry worker process, started by worker.ts once its signal hook is in.
// It rolls the Redis stream up into MySQL and serves Prometheus metrics on METRICS_HOST:METRICS_PORT.
import { hostname } from 'node:os';
import { pino } from 'pino';
import { runWorkerLoop } from './modules/telemetry/runLoop.js';
import { createTelemetryWorker } from './modules/telemetry/worker.js';
import { systemClock } from './platform/clock.js';
import { loadConfig } from './platform/config.js';
import { createPool, pingDb } from './platform/db.js';
import {
  StartupAborted,
  armShutdownDeadline,
  createStartup,
  exitWhenDrained,
  onStop,
  shutdownInOrder,
  workerShutdownSteps,
} from './platform/lifecycle.js';
import { loggerOptions } from './platform/logger.js';
import { createMetrics, startMetricsServer } from './platform/metrics.js';
import { connectRedis } from './platform/redis.js';

const PRUNE_BATCH_SIZE = 10_000;

export async function runWorker(stopSignal: AbortSignal): Promise<void> {
  const config = loadConfig(process.env);
  const log = pino({ ...loggerOptions(config.logLevel), base: { service: 'outpost-worker' } });

  // The loop below sees the same abort and stops after its batch.
  onStop(stopSignal, () => {
    log.info({ signal: String(stopSignal.reason) }, 'stopping after the current batch');
    armShutdownDeadline(log);
  });

  const startup = createStartup(stopSignal);
  try {
    const db = await startup.open(
      'mysql pool',
      async () => {
        const pool = createPool(config.databaseUrl, { connectionLimit: 4 });
        await pingDb(pool);
        return pool;
      },
      (pool) => pool.end(),
    );
    const redis = await startup.open('redis', () => connectRedis(config.redisUrl), (client) => client.quit());
    const metrics = createMetrics({ defaultMetrics: true });
    const consumer = `${hostname()}-${process.pid}`;
    const worker = createTelemetryWorker({ redis, db, consumer, clock: systemClock, logger: log, metrics, pruneBatchSize: PRUNE_BATCH_SIZE });
    await startup.open('consumer group', async () => {
      await worker.ensureGroup();
      // Every container names a new consumer, so clear out the ones old containers left behind.
      const removed = await worker.removeIdleConsumers();
      if (removed.length > 0) log.info({ removed }, 'removed idle telemetry consumers');
    });
    const metricsServer = await startup.open(
      'metrics server',
      () =>
        startMetricsServer(metrics.registry, config.metricsPort, config.metricsHost, {
          onError: (error) => {
            log.fatal({ err: error }, 'metrics server failed');
            process.exit(1);
          },
        }),
      (server) => new Promise((resolve) => server.close(resolve)),
    );

    log.info({ consumer }, 'telemetry worker started');
    await runWorkerLoop({ worker, logger: log, clock: systemClock, signal: stopSignal, pruneBatchSize: PRUNE_BATCH_SIZE });
    exitWhenDrained(await shutdownInOrder(workerShutdownSteps({ metricsServer, redis, db }), log));
  } catch (error) {
    if (!(error instanceof StartupAborted)) throw error;
    log.info('stopped during startup');
    exitWhenDrained(await shutdownInOrder(startup.closeSteps(), log));
  }
}
