// The API entry point: `node dist/server.js` (npm start adds OpenTelemetry with --import).
// The API listens on PORT and Prometheus metrics on METRICS_HOST:METRICS_PORT.
import { pino } from 'pino';
import { buildApp } from './app.js';
import { createAppDeps } from './compose.js';
import { systemClock } from './platform/clock.js';
import { loadConfig } from './platform/config.js';
import { createPool, pingDb } from './platform/db.js';
import { exitWhenDrained, onShutdownSignal, serverShutdownSteps, shutdownInOrder } from './platform/lifecycle.js';
import { loggerOptions } from './platform/logger.js';
import { createMetrics, startMetricsServer } from './platform/metrics.js';
import { connectRedis } from './platform/redis.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  // One logger for everything outside a request: the ledger, the flags service and readiness.
  const log = pino(loggerOptions(config.logLevel));
  const db = createPool(config.databaseUrl);
  await pingDb(db); // a wrong DATABASE_URL fails here, clearly, instead of on the first request
  const redis = await connectRedis(config.redisUrl);
  const metrics = createMetrics({ defaultMetrics: true });
  const deps = await createAppDeps(config, { db, redis, clock: systemClock, metrics }, { logger: log });
  const app = await buildApp(deps);
  const metricsServer = await startMetricsServer(metrics.registry, config.metricsPort, config.metricsHost, {
    onError: (error) => {
      log.fatal({ err: error }, 'metrics server failed');
      process.exit(1);
    },
  });
  if (!config.jwtPrivateKeyPem) log.warn('JWT_PRIVATE_KEY_PEM is not set, using a signing key that lives only as long as this process');

  onShutdownSignal(async (signal) => {
    log.info({ signal }, 'shutting down');
    const code = await shutdownInOrder(serverShutdownSteps({ health: deps.health, app, metricsServer, redis, db }), log);
    log.info({ code }, 'shut down');
    exitWhenDrained(code);
  });
  await app.listen({ host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  // ConfigError, pingDb and connectRedis messages name what failed but never print a URL or secret.
  console.error(error);
  process.exit(1);
});
