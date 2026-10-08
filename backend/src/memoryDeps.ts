import type { AppDeps } from './app.js';
import { FAST_ARGON2, createArgon2Hasher, makeDummyHash } from './modules/identity/crypto/password.js';
import type { PasswordHasher } from './modules/identity/crypto/password.js';
import { createTokenService, generateKeyPair } from './modules/identity/crypto/tokenService.js';
import { LOGIN_LIMITS, REFRESH_LIMIT, createLoginLimiter } from './modules/identity/limiter/loginLimiter.js';
import { SlidingWindowCounter, createMemoryWindowStore } from './modules/identity/limiter/slidingWindow.js';
import type { WindowStore } from './modules/identity/limiter/slidingWindow.js';
import { createMemoryOperatorRepo } from './modules/identity/repos/operatorRepo.js';
import type { OperatorRepo } from './modules/identity/repos/operatorRepo.js';
import { createAuthService } from './modules/identity/services/authService.js';
import { createMemoryIdentityStores } from './modules/identity/stores/memoryStores.js';
import { systemClock } from './platform/clock.js';
import type { Clock } from './platform/clock.js';
import type { AppConfig } from './platform/config.js';

// The whole app wired to in-memory fakes: unit tests and the OpenAPI export use this.
// It never touches a network and is never used to serve real traffic.
export const MEMORY_CONFIG: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 0,
  metricsPort: 0,
  databaseUrl: 'mysql://unused',
  redisUrl: 'redis://unused',
  jwtIssuer: 'outpost',
  jwtPrivateKeyPem: null,
  logLevel: 'silent',
  trustProxy: false,
};

export interface MemoryApp {
  deps: AppDeps;
  clock: Clock;
  operators: OperatorRepo;
  hasher: PasswordHasher;
}

export interface MemoryOptions {
  clock?: Clock;
  // Builds the store behind each rate limit counter. Tests pass a failing one to prove fail closed.
  windowStore?: () => WindowStore;
}

export async function createMemoryAppDeps(options: MemoryOptions = {}): Promise<MemoryApp> {
  const clock = options.clock ?? systemClock;
  const windowStore = options.windowStore ?? createMemoryWindowStore;
  const hasher = createArgon2Hasher(FAST_ARGON2);
  const tokens = createTokenService(await generateKeyPair(), { now: () => clock.now() });
  const operators = createMemoryOperatorRepo();
  const stores = createMemoryIdentityStores(clock);
  const counter = (limits: { limit: number; windowMs: number }) => new SlidingWindowCounter({ ...limits, clock, store: windowStore() });

  const auth = createAuthService({
    operators,
    sessions: stores.sessions,
    refresh: stores.refresh,
    tokens,
    hasher,
    dummyHash: await makeDummyHash(hasher), // once per app, never per request
    loginLimiter: createLoginLimiter({
      perIp: counter(LOGIN_LIMITS.perIp),
      perIpAccount: counter(LOGIN_LIMITS.perIpAccount),
      perAccount: counter(LOGIN_LIMITS.perAccount),
    }),
    refreshLimiter: counter(REFRESH_LIMIT),
    clock,
  });

  return { deps: { config: MEMORY_CONFIG, tokens, auth }, clock, operators, hasher };
}
