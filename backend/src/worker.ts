// The telemetry worker entry point: `node dist/worker.js` (npm run start:worker adds OpenTelemetry).
// It rolls the Redis stream up into MySQL and serves Prometheus metrics on METRICS_HOST:METRICS_PORT.
import { hostname } from 'node:os';
import { pino } from 'pino';
import { runWorkerLoop } from './modules/telemetry/runLoop.js';
import { createTelemetryWorker } from './modules/telemetry/worker.js';
import { systemClock } from './platform/clock.js';
import { loadConfig } from './platform/config.js';
import { createPool, pingDb } from './platform/db.js';
import { exitWhenDrained, onShutdownSignal, shutdownInOrder, workerShutdownSteps } from './platform/lifecycle.js';
import { loggerOptions } from './platform/logger.js';
import { createMetrics, startMetricsServer } from './platform/metrics.js';
import { connectRedis } from './platform/redis.js';

const PRUNE_BATCH_SIZE = 10_000;

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const log = pino({ ...loggerOptions(config.logLevel), base: { service: 'outpost-worker' } });
  const db = createPool(config.databaseUrl, { connectionLimit: 4 });
  await pingDb(db);
  const redis = await connectRedis(config.redisUrl);
  const metrics = createMetrics({ defaultMetrics: true });
  const worker = createTelemetryWorker({
    redis,
    db,
    consumer: `${hostname()}-${process.pid}`,
    clock: systemClock,
    logger: log,
    metrics,
    pruneBatchSize: PRUNE_BATCH_SIZE,
  });
  await worker.ensureGroup();
  const metricsServer = await startMetricsServer(metrics.registry, config.metricsPort, config.metricsHost, {
    onError: (error) => {
      log.fatal({ err: error }, 'metrics server failed');
      process.exit(1);
    },
  });

  const stop = new AbortController();
  onShutdownSignal((signal) => {
    log.info({ signal }, 'stopping after the current batch');
    stop.abort();
  });
  log.info({ consumer: `${hostname()}-${process.pid}` }, 'telemetry worker started');
  await runWorkerLoop({ worker, logger: log, clock: systemClock, signal: stop.signal, pruneBatchSize: PRUNE_BATCH_SIZE });

  const code = await shutdownInOrder(workerShutdownSteps({ metricsServer, redis, db }), log);
  log.info({ code }, 'shut down');
  exitWhenDrained(code);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
