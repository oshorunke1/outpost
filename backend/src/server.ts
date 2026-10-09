// The API entry point: `node dist/server.js` (npm start adds OpenTelemetry with --import).
// The API listens on PORT and Prometheus metrics on METRICS_HOST:METRICS_PORT.
import { pino } from 'pino';
import { buildApp } from './app.js';
import { createAppDeps } from './compose.js';
import { systemClock } from './platform/clock.js';
import { loadConfig } from './platform/config.js';
import { createPool, pingDb } from './platform/db.js';
import {
  StartupAborted,
  armShutdownDeadline,
  createStartup,
  exitWhenDrained,
  onShutdownSignal,
  serverShutdownSteps,
  shutdownInOrder,
} from './platform/lifecycle.js';
import { loggerOptions } from './platform/logger.js';
import { createMetrics, startMetricsServer } from './platform/metrics.js';
import { connectRedis } from './platform/redis.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  // One logger for everything outside a request: the ledger, the flags service and readiness.
  const log = pino(loggerOptions(config.logLevel));

  // The signal hook goes in before any startup work, so a stop during startup is never lost.
  const stop = new AbortController();
  let shutdown: (() => Promise<number>) | null = null; // set once everything is up
  onShutdownSignal(async (signal) => {
    log.info({ signal }, 'shutting down');
    armShutdownDeadline(log);
    stop.abort();
    if (shutdown) exitWhenDrained(await shutdown());
  });

  const startup = createStartup(stop.signal);
  try {
    const db = await startup.open(
      'mysql pool',
      async () => {
        const pool = createPool(config.databaseUrl);
        await pingDb(pool); // a wrong DATABASE_URL fails here, clearly, instead of on the first request
        return pool;
      },
      (pool) => pool.end(),
    );
    const redis = await startup.open('redis', () => connectRedis(config.redisUrl), (client) => client.quit());
    const metrics = createMetrics({ defaultMetrics: true });
    const deps = await startup.open('app deps', () => createAppDeps(config, { db, redis, clock: systemClock, metrics }, { logger: log }));
    const app = await startup.open('app', () => buildApp(deps), (built) => built.close());
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
    shutdown = () => shutdownInOrder(serverShutdownSteps({ health: deps.health, app, metricsServer, redis, db }), log);
    if (!config.jwtPrivateKeyPem) log.warn('JWT_PRIVATE_KEY_PEM is not set, using a signing key that lives only as long as this process');
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    if (!(error instanceof StartupAborted)) throw error;
    log.info('stopped during startup');
    exitWhenDrained(await shutdownInOrder(startup.closeSteps(), log));
  }
}

main().catch((error: unknown) => {
  // ConfigError, pingDb and connectRedis messages name what failed but never print a URL or secret.
  console.error(error);
  process.exit(1);
});
