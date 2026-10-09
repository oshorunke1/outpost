import type { AppDeps } from './app.js';
import type { LedgerService } from './modules/economy/ledger.js';
import { createMemoryFlagsService } from './modules/flags/flagsService.js';
import { FAST_ARGON2, createArgon2Hasher, makeDummyHash } from './modules/identity/crypto/password.js';
import type { PasswordHasher } from './modules/identity/crypto/password.js';
import { createTokenService, generateKeyPair } from './modules/identity/crypto/tokenService.js';
import {
  LOGIN_LIMITS,
  REFRESH_LIMIT,
  SERVICE_TOKEN_IP_FAILURE_LIMIT,
  SERVICE_TOKEN_LIMIT,
  createLoginLimiter,
} from './modules/identity/limiter/loginLimiter.js';
import { SlidingWindowCounter, createMemoryWindowStore } from './modules/identity/limiter/slidingWindow.js';
import type { WindowStore } from './modules/identity/limiter/slidingWindow.js';
import { API_LIMIT, BLOCKED_VERIFY_LIMIT, TokenBucketLimiter } from './modules/identity/limiter/tokenBucket.js';
import { createMemoryOperatorRepo } from './modules/identity/repos/operatorRepo.js';
import type { OperatorRepo } from './modules/identity/repos/operatorRepo.js';
import { createMemoryServiceClientRepo } from './modules/identity/repos/serviceClientRepo.js';
import type { ServiceClientRepo } from './modules/identity/repos/serviceClientRepo.js';
import { GAME_SCOPES } from './modules/identity/scopes.js';
import { GAME_CLIENT_ID } from './modules/identity/seed.js';
import { createAuthService } from './modules/identity/services/authService.js';
import { createServiceTokenService } from './modules/identity/services/serviceTokenService.js';
import { createMemoryIdentityStores } from './modules/identity/stores/memoryStores.js';
import { createMemoryPlayersService } from './modules/players/playersService.js';
import { createMemoryTelemetryProducer } from './modules/telemetry/producer.js';
import type { MemoryTelemetryProducer } from './modules/telemetry/producer.js';
import { systemClock } from './platform/clock.js';
import type { Clock } from './platform/clock.js';
import type { AppConfig } from './platform/config.js';
import { AppError } from './platform/errors.js';

// The whole app wired to in-memory fakes: unit tests and the OpenAPI export use this.
// It never touches a network and is never used to serve real traffic.
export const MEMORY_CONFIG: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 0,
  metricsPort: 0,
  metricsHost: '127.0.0.1',
  databaseUrl: 'mysql://unused',
  redisUrl: 'redis://unused',
  jwtIssuer: 'outpost',
  jwtPrivateKeyPem: null,
  logLevel: 'silent',
  trustProxy: false,
  telemetryApiLimit: { capacity: 200, refillPerSecond: 150 },
};

export interface MemoryApp {
  deps: AppDeps;
  clock: Clock;
  operators: OperatorRepo;
  serviceClients: ServiceClientRepo;
  hasher: PasswordHasher;
  // Every event the telemetry route published, in order. Tests read it.
  telemetry: MemoryTelemetryProducer;
}

export interface MemoryOptions {
  clock?: Clock;
  // Builds the store behind each rate limit counter. Tests pass a failing one to prove fail closed.
  windowStore?: () => WindowStore;
  // Replaces any of the built deps, for example a test ledger. Applied last.
  overrides?: Partial<AppDeps>;
}

// The ledger's guarantees come from MySQL row locks, triggers and constraints, so it has no
// in-memory twin. Route tests pass their own ledger through overrides.
const unavailable = async (): Promise<never> => Promise.reject(new AppError(503, 'ledger_unavailable', 'The ledger needs MySQL'));
const unavailableLedger: LedgerService = {
  submit: unavailable,
  refund: unavailable,
  markFulfilled: unavailable,
  unfulfilledPurchases: unavailable,
  systemBalance: unavailable,
};

export async function createMemoryAppDeps(options: MemoryOptions = {}): Promise<MemoryApp> {
  const clock = options.clock ?? systemClock;
  const windowStore = options.windowStore ?? createMemoryWindowStore;
  const hasher = createArgon2Hasher(FAST_ARGON2);
  const tokens = createTokenService(await generateKeyPair(), { now: () => clock.now() });
  const operators = createMemoryOperatorRepo();
  const stores = createMemoryIdentityStores(clock);
  const counter = (limits: { limit: number; windowMs: number }) => new SlidingWindowCounter({ ...limits, clock, store: windowStore() });
  const dummyHash = await makeDummyHash(hasher); // once per app, never per request

  const auth = createAuthService({
    operators,
    sessions: stores.sessions,
    refresh: stores.refresh,
    tokens,
    hasher,
    dummyHash,
    loginLimiter: createLoginLimiter({
      perIp: counter(LOGIN_LIMITS.perIp),
      perIpAccount: counter(LOGIN_LIMITS.perIpAccount),
      perAccount: counter(LOGIN_LIMITS.perAccount),
    }),
    refreshLimiter: counter(REFRESH_LIMIT),
    clock,
  });

  // The game-server client exists from the start, with a random secret nobody knows, so tests can
  // sign game tokens with gameToken(). A test that exchanges a key upserts its own secret.
  const serviceClients = createMemoryServiceClientRepo();
  await serviceClients.upsert({ clientId: GAME_CLIENT_ID, secretHash: await makeDummyHash(hasher), scopes: GAME_SCOPES });
  const serviceTokens = createServiceTokenService({
    clients: serviceClients,
    tokens,
    hasher,
    dummyHash,
    clock,
    perClient: counter(SERVICE_TOKEN_LIMIT),
    ipFailures: counter(SERVICE_TOKEN_IP_FAILURE_LIMIT),
    blockedVerify: new TokenBucketLimiter({ ...BLOCKED_VERIFY_LIMIT, clock }),
  });
  const apiLimiter = new TokenBucketLimiter({ ...API_LIMIT, clock });
  const telemetry = createMemoryTelemetryProducer();

  return {
    deps: {
      config: MEMORY_CONFIG,
      tokens,
      auth,
      serviceTokens,
      apiLimiter,
      players: createMemoryPlayersService(),
      ledger: unavailableLedger,
      clock,
      telemetry,
      flags: createMemoryFlagsService(),
      ...options.overrides,
    },
    clock,
    operators,
    serviceClients,
    hasher,
    telemetry,
  };
}
