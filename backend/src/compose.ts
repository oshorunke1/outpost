import { pino } from 'pino';
import type { AppDeps } from './app.js';
import { createLedgerService } from './modules/economy/ledger.js';
import { generateKeyPair, importSigningKey } from './modules/identity/crypto/keys.js';
import type { SigningKey } from './modules/identity/crypto/keys.js';
import { PRODUCTION_ARGON2, createArgon2Hasher, makeDummyHash } from './modules/identity/crypto/password.js';
import type { Argon2Params } from './modules/identity/crypto/password.js';
import { createTokenService } from './modules/identity/crypto/tokenService.js';
import {
  LOGIN_LIMITS,
  REFRESH_LIMIT,
  SERVICE_TOKEN_IP_FAILURE_LIMIT,
  SERVICE_TOKEN_LIMIT,
  createLoginLimiter,
} from './modules/identity/limiter/loginLimiter.js';
import { SlidingWindowCounter, createRedisWindowStore } from './modules/identity/limiter/slidingWindow.js';
import { API_LIMIT, BLOCKED_VERIFY_LIMIT, TokenBucketLimiter } from './modules/identity/limiter/tokenBucket.js';
import { createMysqlOperatorRepo } from './modules/identity/repos/operatorRepo.js';
import { createMysqlServiceClientRepo } from './modules/identity/repos/serviceClientRepo.js';
import { createAuthService } from './modules/identity/services/authService.js';
import { createServiceTokenService } from './modules/identity/services/serviceTokenService.js';
import { createRedisIdentityStores } from './modules/identity/stores/redisStores.js';
import { createMysqlPlayersService } from './modules/players/playersService.js';
import { createRedisTelemetryProducer } from './modules/telemetry/producer.js';
import type { Clock } from './platform/clock.js';
import type { AppConfig } from './platform/config.js';
import type { Db, TransactionLogger } from './platform/db.js';
import { loggerOptions } from './platform/logger.js';
import type { Redis } from './platform/redis.js';

export interface Infra {
  db: Db;
  redis: Redis;
  clock: Clock;
}

export interface ComposeOptions {
  argon2?: Argon2Params; // integration tests pass FAST_ARGON2; everything else gets PRODUCTION_ARGON2
  // Where the ledger reports a lost COMMIT or a failed rollback. Defaults to a logger with the
  // app's level, redaction and service name on stdout; tests pass one they can read.
  logger?: TransactionLogger;
}

// Production loads the PEM from JWT_PRIVATE_KEY_PEM (loadConfig already insists on it, and this
// checks again). Development and tests get a fresh key per process that only ever lives in memory,
// so nothing is written to disk and tokens do not survive a restart there.
export async function loadSigningKey(config: AppConfig): Promise<SigningKey> {
  if (config.jwtPrivateKeyPem) return importSigningKey(config.jwtPrivateKeyPem);
  if (config.nodeEnv === 'production') throw new Error('JWT_PRIVATE_KEY_PEM is required in production');
  return generateKeyPair();
}

export async function createAppDeps(config: AppConfig, infra: Infra, options: ComposeOptions = {}): Promise<AppDeps> {
  const { db, redis, clock } = infra;
  const hasher = createArgon2Hasher(options.argon2 ?? PRODUCTION_ARGON2);
  const tokens = createTokenService(await loadSigningKey(config), { issuer: config.jwtIssuer, now: () => clock.now() });
  const stores = createRedisIdentityStores(redis);
  const counter = (prefix: string, limits: { limit: number; windowMs: number }) =>
    new SlidingWindowCounter({ ...limits, clock, store: createRedisWindowStore(redis, prefix) });
  const dummyHash = await makeDummyHash(hasher); // once at boot, never per request

  const auth = createAuthService({
    operators: createMysqlOperatorRepo(db, clock),
    sessions: stores.sessions,
    refresh: stores.refresh,
    tokens,
    hasher,
    dummyHash,
    loginLimiter: createLoginLimiter({
      perIp: counter('ratelimit:login:ip', LOGIN_LIMITS.perIp),
      perIpAccount: counter('ratelimit:login:ipaccount', LOGIN_LIMITS.perIpAccount),
      perAccount: counter('ratelimit:login:account', LOGIN_LIMITS.perAccount),
    }),
    refreshLimiter: counter('ratelimit:refresh', REFRESH_LIMIT),
    clock,
  });

  const serviceTokens = createServiceTokenService({
    clients: createMysqlServiceClientRepo(db, clock),
    tokens,
    hasher,
    dummyHash,
    clock,
    perClient: counter('ratelimit:service-token:client', SERVICE_TOKEN_LIMIT),
    ipFailures: counter('ratelimit:service-token:ipfail', SERVICE_TOKEN_IP_FAILURE_LIMIT),
    // Per instance, like the API limiter. It only ever loosens a block, by about one check a second.
    blockedVerify: new TokenBucketLimiter({ ...BLOCKED_VERIFY_LIMIT, clock }),
  });
  const apiLimiter = new TokenBucketLimiter({ ...API_LIMIT, clock });

  const logger = options.logger ?? pino(loggerOptions(config.logLevel)).child({ module: 'ledger' });
  const ledger = createLedgerService(db, clock, { logger });

  return {
    config,
    tokens,
    auth,
    serviceTokens,
    apiLimiter,
    players: createMysqlPlayersService(db, clock),
    ledger,
    clock,
    telemetry: createRedisTelemetryProducer(redis),
  };
}
