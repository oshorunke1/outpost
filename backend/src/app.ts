import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { DestinationStream } from 'pino';
import type { TokenService } from './modules/identity/crypto/tokenService.js';
import { registerIdentityRoutes } from './modules/identity/routes.js';
import type { AuthService } from './modules/identity/services/authService.js';
import type { AppConfig, TrustProxy } from './platform/config.js';
import { registerErrorHandler } from './platform/errors.js';
import type { ZodApp } from './platform/http.js';
import { loggerOptions } from './platform/logger.js';

// Everything the routes need. compose.ts fills it with MySQL and Redis, memoryDeps.ts with fakes.
export interface AppDeps {
  config: AppConfig;
  tokens: TokenService;
  auth: AuthService;
}

export interface BuildOptions {
  // Where log lines go. Defaults to stdout; tests pass a stream to read what was logged.
  logStream?: DestinationStream;
}

// Every route takes small JSON bodies. Anything bigger is refused with 413 before it is parsed.
export const BODY_LIMIT_BYTES = 16 * 1024;

// Fastify reads a plain number as "trust nothing" on purpose, so a hop count becomes a function
// that trusts the nearest N hops. Only safe when the app can be reached through the proxy alone.
function fastifyTrustProxy(trustProxy: TrustProxy): false | string[] | ((address: string, hop: number) => boolean) {
  if (typeof trustProxy === 'number') return (_address, hop) => hop < trustProxy;
  return trustProxy;
}

export async function buildApp(deps: AppDeps, options: BuildOptions = {}): Promise<ZodApp> {
  const logger = { ...loggerOptions(deps.config.logLevel), ...(options.logStream ? { stream: options.logStream } : {}) };
  const app = Fastify({
    logger,
    trustProxy: fastifyTrustProxy(deps.config.trustProxy),
    bodyLimit: BODY_LIMIT_BYTES,
    genReqId: () => randomUUID(),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('principal', null);
  registerErrorHandler(app);

  registerIdentityRoutes(app, deps);
  return app;
}
