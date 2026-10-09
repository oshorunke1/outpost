import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { DestinationStream } from 'pino';
import type { LedgerService } from './modules/economy/ledger.js';
import { registerEconomyRoutes } from './modules/economy/routes.js';
import type { FlagsService } from './modules/flags/flagsService.js';
import { registerFlagRoutes } from './modules/flags/routes.js';
import type { TokenService } from './modules/identity/crypto/tokenService.js';
import { serviceGuard } from './modules/identity/guards.js';
import type { ApiGroup, GuardFor } from './modules/identity/guards.js';
import { TokenBucketLimiter } from './modules/identity/limiter/tokenBucket.js';
import { registerIdentityRoutes } from './modules/identity/routes.js';
import type { AuthService } from './modules/identity/services/authService.js';
import type { ServiceTokenService } from './modules/identity/services/serviceTokenService.js';
import type { PlayersService } from './modules/players/playersService.js';
import { registerPlayerRoutes } from './modules/players/routes.js';
import type { TelemetryProducer } from './modules/telemetry/producer.js';
import { registerTelemetryRoutes } from './modules/telemetry/routes.js';
import type { Clock } from './platform/clock.js';
import type { AppConfig } from './platform/config.js';
import { registerErrorHandler } from './platform/errors.js';
import { registerHealthRoutes } from './platform/health.js';
import type { HealthChecks } from './platform/health.js';
import type { ZodApp } from './platform/http.js';
import { loggerOptions } from './platform/logger.js';
import { registerHttpMetrics } from './platform/metrics.js';
import type { Metrics } from './platform/metrics.js';

// Everything the routes need. compose.ts fills it with MySQL and Redis, memoryDeps.ts with fakes.
export interface AppDeps {
  config: AppConfig;
  tokens: TokenService;
  auth: AuthService;
  serviceTokens: ServiceTokenService;
  apiLimiter: TokenBucketLimiter;
  players: PlayersService;
  ledger: LedgerService;
  clock: Clock;
  telemetry: TelemetryProducer;
  flags: FlagsService;
  metrics: Metrics;
  health: HealthChecks;
}

export interface BuildOptions {
  // Where log lines go. Defaults to stdout; tests pass a stream to read what was logged.
  logStream?: DestinationStream;
}

// Every route takes small JSON bodies. Anything bigger is refused with 413 before it is parsed.
export const BODY_LIMIT_BYTES = 16 * 1024;

export async function buildApp(deps: AppDeps, options: BuildOptions = {}): Promise<ZodApp> {
  const logger = { ...loggerOptions(deps.config.logLevel), ...(options.logStream ? { stream: options.logStream } : {}) };
  const app = Fastify({
    logger,
    trustProxy: deps.config.trustProxy, // false or a proxy CIDR list, see config.ts
    bodyLimit: BODY_LIMIT_BYTES,
    genReqId: () => randomUUID(),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('principal', null);
  registerErrorHandler(app);
  registerHttpMetrics(app, deps.metrics);

  // One bucket per group. Telemetry's is per instance like apiLimiter, sized from TELEMETRY_API_LIMIT.
  const limiters: Record<ApiGroup, TokenBucketLimiter> = {
    default: deps.apiLimiter,
    telemetry: new TokenBucketLimiter({ ...deps.config.telemetryApiLimit, clock: deps.clock }),
  };
  const guardFor: GuardFor = (scope, group = 'default') => serviceGuard(deps.serviceTokens, limiters[group], scope, group);
  registerHealthRoutes(app, deps.health);
  registerIdentityRoutes(app, deps);
  registerPlayerRoutes(app, { players: deps.players, guardFor });
  registerEconomyRoutes(app, { ledger: deps.ledger, metrics: deps.metrics, guardFor });
  registerTelemetryRoutes(app, { telemetry: deps.telemetry, clock: deps.clock, flags: deps.flags, metrics: deps.metrics, guardFor });
  registerFlagRoutes(app, { flags: deps.flags, guardFor });
  return app;
}
