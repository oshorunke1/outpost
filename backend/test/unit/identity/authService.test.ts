import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { FAST_ARGON2, createArgon2Hasher, makeDummyHash } from '../../../src/modules/identity/crypto/password.js';
import type { PasswordHasher } from '../../../src/modules/identity/crypto/password.js';
import { createTokenService, generateKeyPair } from '../../../src/modules/identity/crypto/tokenService.js';
import { LOGIN_LIMITS, REFRESH_LIMIT, createLoginLimiter } from '../../../src/modules/identity/limiter/loginLimiter.js';
import { SlidingWindowCounter, createMemoryWindowStore } from '../../../src/modules/identity/limiter/slidingWindow.js';
import type { WindowStore } from '../../../src/modules/identity/limiter/slidingWindow.js';
import { createMemoryOperatorRepo } from '../../../src/modules/identity/repos/operatorRepo.js';
import type { OperatorRepo } from '../../../src/modules/identity/repos/operatorRepo.js';
import { OPERATOR_SCOPES } from '../../../src/modules/identity/scopes.js';
import { createAuthService, failClosed } from '../../../src/modules/identity/services/authService.js';
import { createMemoryIdentityStores } from '../../../src/modules/identity/stores/memoryStores.js';
import type { RefreshStore, SessionStore } from '../../../src/modules/identity/stores/types.js';
import { AppError } from '../../../src/platform/errors.js';
import { createFakeClock } from '../../support/clock.js';

const PASSWORD = 'correct horse battery staple';
const EMAIL = 'operator@outpost.local';
const OTHER_EMAIL = 'other@outpost.local';
const signingKey = generateKeyPair(); // RSA key generation is slow, so every test shares one key

function countingHasher(inner: PasswordHasher): PasswordHasher & { verifies: string[] } {
  const verifies: string[] = [];
  return {
    verifies,
    hash: (plain) => inner.hash(plain),
    verify: async (stored, plain) => {
      verifies.push(stored);
      return inner.verify(stored, plain);
    },
  };
}

const down = async (): Promise<never> => Promise.reject(new Error('redis down'));
const brokenSessions: SessionStore = { create: down, get: down, listForOperator: down, delete: down, deleteAllForOperator: down };
const brokenWindowStore: WindowStore = { increment: down };

// Wraps a store so a test can make chosen methods fail, then heal it again.
function switchable<T extends object>(inner: T): { store: T; fail: Set<keyof T> } {
  const fail = new Set<keyof T>();
  const store = new Proxy(inner, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => (fail.has(property as keyof T) ? down() : (value as (...a: unknown[]) => unknown).apply(target, args));
    },
  });
  return { store, fail };
}

interface SetupOptions {
  sessions?: (inner: SessionStore) => SessionStore;
  refresh?: (inner: RefreshStore) => RefreshStore;
  operators?: (inner: OperatorRepo) => OperatorRepo;
  loginStore?: () => WindowStore;
  refreshStore?: () => WindowStore;
}

async function setup(options: SetupOptions = {}) {
  const clock = createFakeClock();
  const hasher = countingHasher(createArgon2Hasher(FAST_ARGON2));
  const repo = createMemoryOperatorRepo();
  const stores = createMemoryIdentityStores(clock);
  const tokens = createTokenService(await signingKey, { now: () => clock.now() });
  const operator = await repo.create({ email: EMAIL, passwordHash: await hasher.hash(PASSWORD), scopes: OPERATOR_SCOPES });
  const other = await repo.create({ email: OTHER_EMAIL, passwordHash: await hasher.hash(PASSWORD), scopes: OPERATOR_SCOPES });
  const dummyHash = await makeDummyHash(hasher);
  const counter = (limits: { limit: number; windowMs: number }, store: WindowStore) => new SlidingWindowCounter({ ...limits, clock, store });
  const loginStore = options.loginStore ?? createMemoryWindowStore;
  const auth = createAuthService({
    operators: options.operators ? options.operators(repo) : repo,
    sessions: options.sessions ? options.sessions(stores.sessions) : stores.sessions,
    refresh: options.refresh ? options.refresh(stores.refresh) : stores.refresh,
    tokens,
    hasher,
    dummyHash,
    loginLimiter: createLoginLimiter({
      perIp: counter(LOGIN_LIMITS.perIp, loginStore()),
      perIpAccount: counter(LOGIN_LIMITS.perIpAccount, loginStore()),
      perAccount: counter(LOGIN_LIMITS.perAccount, loginStore()),
    }),
    refreshLimiter: counter(REFRESH_LIMIT, (options.refreshStore ?? createMemoryWindowStore)()),
    clock,
  });
  const login = (email = EMAIL, ip = '10.0.0.1') => auth.login({ email, password: PASSWORD, ip, userAgent: 'vitest' });
  const refresh = (refreshToken: string) => auth.refresh({ refreshToken, ip: '10.0.0.1' });
  return { auth, clock, hasher, dummyHash, repo, operator, other, stores, tokens, login, refresh };
}

// Every negative test goes through this, so each one pins the status AND the error code.
async function expectAppError(promise: Promise<unknown>, statusCode: number, code: string): Promise<AppError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ statusCode, code });
  return error as AppError;
}

describe('AuthService login', () => {
  test('login returns a token pair whose access token authenticates as that operator and session', async () => {
    const { auth, login, operator } = await setup();
    const pair = await login();
    expect(pair).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
    const principal = await auth.authenticate(pair.accessToken);
    expect(principal).toMatchObject({ kind: 'operator', operatorId: operator.id, scopes: [...OPERATOR_SCOPES] });
    const sessions = await auth.listSessions(principal);
    expect(sessions.map((s) => s.sessionId)).toEqual([principal.sessionId]);
  });

  test('email case and spaces do not matter', async () => {
    const { login } = await setup();
    await expect(login('  OPERATOR@Outpost.Local ')).resolves.toMatchObject({ tokenType: 'Bearer' });
  });

  test('wrong password and unknown email fail identically, and an unknown email still runs Argon2 on the dummy hash', async () => {
    const { auth, hasher, dummyHash, operator } = await setup();
    const wrong = await expectAppError(auth.login({ email: EMAIL, password: 'nope', ip: '10.0.0.1', userAgent: '' }), 401, 'invalid_credentials');
    const unknown = await expectAppError(
      auth.login({ email: 'ghost@outpost.local', password: 'nope', ip: '10.0.0.2', userAgent: '' }),
      401,
      'invalid_credentials',
    );
    expect(unknown.message).toBe(wrong.message);
    // Same work on both paths: one verify each, and the unknown email's verify was against the dummy.
    expect(hasher.verifies).toEqual([operator.passwordHash, dummyHash]);
  });

  test('the sixth attempt from one IP at one account is rate limited before Argon2 runs', async () => {
    const { auth, hasher } = await setup();
    for (let i = 0; i < 5; i += 1) {
      await expectAppError(auth.login({ email: EMAIL, password: 'nope', ip: '10.0.1.1', userAgent: '' }), 401, 'invalid_credentials');
    }
    const blocked = await expectAppError(auth.login({ email: EMAIL, password: PASSWORD, ip: '10.0.1.1', userAgent: '' }), 429, 'rate_limited');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(hasher.verifies).toHaveLength(5);
  });

  test('the limiter sees the raw email and still buckets case and spacing variants together', async () => {
    const { login } = await setup();
    for (const email of ['OPERATOR@outpost.local', ' operator@outpost.local', 'Operator@Outpost.Local', 'operator@OUTPOST.local ', EMAIL]) {
      await login(email, '10.0.2.1');
    }
    await expectAppError(login('  OPERATOR@OUTPOST.LOCAL', '10.0.2.1'), 429, 'rate_limited');
  });

  test('if the family cannot be stored, login fails closed and leaves no orphan session behind', async () => {
    const { login, stores, operator } = await setup({ refresh: (inner) => ({ ...inner, create: down }) });
    await expectAppError(login(), 503, 'auth_unavailable');
    await expect(stores.sessions.listForOperator(operator.id)).resolves.toEqual([]);
  });
});

describe('AuthService refresh', () => {
  // identity-service design test 1
  test('refresh issues a new pair for the same session', async () => {
    const { auth, login, refresh } = await setup();
    const first = await login();
    const second = await refresh(first.refreshToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.refreshToken.split('.')[0]).toBe(first.refreshToken.split('.')[0]);
    const before = await auth.authenticate(first.accessToken);
    await expect(auth.authenticate(second.accessToken)).resolves.toMatchObject({ kind: 'operator', sessionId: before.sessionId });
  });

  // identity-service design test 2
  test('replaying a rotated refresh token revokes the whole family and its session', async () => {
    const { auth, login, refresh } = await setup();
    const first = await login();
    const second = await refresh(first.refreshToken);
    await expectAppError(refresh(first.refreshToken), 401, 'refresh_token_reused');
    await expectAppError(refresh(second.refreshToken), 401, 'invalid_refresh_token');
    await expectAppError(auth.authenticate(second.accessToken), 401, 'unauthorized');
  });

  test('a forged secret on a real family is a plain 401 and revokes nothing', async () => {
    const { auth, login, refresh } = await setup();
    const pair = await login();
    const familyId = pair.refreshToken.split('.')[0] ?? '';
    await expectAppError(refresh(`${familyId}.${'A'.repeat(43)}`), 401, 'invalid_refresh_token');
    await expect(auth.authenticate(pair.accessToken)).resolves.toMatchObject({ kind: 'operator' });
    await expect(refresh(pair.refreshToken)).resolves.toMatchObject({ tokenType: 'Bearer' });
  });

  test('a malformed or unknown refresh token is a plain 401', async () => {
    const { refresh } = await setup();
    await expectAppError(refresh('garbage'), 401, 'invalid_refresh_token');
    await expectAppError(refresh(`${randomUUID()}.${'a'.repeat(43)}`), 401, 'invalid_refresh_token');
  });

  test('a store failure during validation consumes nothing, and the same token works once the store heals', async () => {
    const sessions = { current: undefined as ReturnType<typeof switchable<SessionStore>> | undefined };
    const { login, refresh } = await setup({
      sessions: (inner) => {
        sessions.current = switchable(inner);
        return sessions.current.store;
      },
    });
    const pair = await login();
    sessions.current?.fail.add('get');
    await expectAppError(refresh(pair.refreshToken), 503, 'auth_unavailable');
    sessions.current?.fail.clear();
    await expect(refresh(pair.refreshToken)).resolves.toMatchObject({ tokenType: 'Bearer' });
  });

  test('a failed operator check consumes nothing, and the same token works once the operator is back', async () => {
    let hidden = false;
    const { login, refresh } = await setup({
      operators: (inner) => ({ ...inner, findById: async (id) => (hidden ? null : inner.findById(id)) }),
    });
    const pair = await login();
    hidden = true;
    await expectAppError(refresh(pair.refreshToken), 401, 'invalid_refresh_token');
    hidden = false;
    await expect(refresh(pair.refreshToken)).resolves.toMatchObject({ tokenType: 'Bearer' });
  });

  test('a rotate that fails consumes nothing', async () => {
    const holder = { current: undefined as ReturnType<typeof switchable<RefreshStore>> | undefined };
    const { login, refresh } = await setup({
      refresh: (inner) => {
        holder.current = switchable(inner);
        return holder.current.store;
      },
    });
    const pair = await login();
    holder.current?.fail.add('rotate');
    await expectAppError(refresh(pair.refreshToken), 503, 'auth_unavailable');
    holder.current?.fail.clear();
    await expect(refresh(pair.refreshToken)).resolves.toMatchObject({ tokenType: 'Bearer' });
  });

  test('a family from an older tokenVersion cannot refresh', async () => {
    const { login, refresh, repo, operator } = await setup();
    const pair = await login();
    await repo.bumpTokenVersion(operator.id);
    await expectAppError(refresh(pair.refreshToken), 401, 'invalid_refresh_token');
  });

  test('two refreshes racing with one token: one wins, the other is a reuse, and the family is revoked', async () => {
    const { login, refresh } = await setup();
    const pair = await login();
    const results = await Promise.allSettled([refresh(pair.refreshToken), refresh(pair.refreshToken)]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]?.reason).toMatchObject({ statusCode: 401, code: 'refresh_token_reused' });
    // This is the intended reuse behaviour, not a bug: the store cannot tell a client that retried
    // too fast from an attacker who copied the token, so it treats both as theft and ends the family.
    // The winner's fresh token dies with it and the operator signs in again.
    const winner = won[0]?.status === 'fulfilled' ? won[0].value.refreshToken : '';
    await expectAppError(refresh(winner), 401, 'invalid_refresh_token');
  });

  test('the sixty first refresh in a minute from one IP is rate limited', async () => {
    const { login, refresh } = await setup();
    const pair = await login();
    for (let i = 0; i < 60; i += 1) await expectAppError(refresh('garbage'), 401, 'invalid_refresh_token');
    const blocked = await expectAppError(refresh(pair.refreshToken), 429, 'rate_limited');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('AuthService sessions', () => {
  // identity-service design test 3, and S2-F9 (a)
  test('logoutAll bumps tokenVersion once and rejects every access and refresh token issued before it', async () => {
    const { auth, login, refresh, repo, operator } = await setup();
    const laptop = await login();
    const phone = await login();
    const principal = await auth.authenticate(laptop.accessToken);
    await auth.logoutAll(principal);
    await expect(repo.findById(operator.id)).resolves.toMatchObject({ tokenVersion: operator.tokenVersion + 1 });
    await expectAppError(auth.authenticate(laptop.accessToken), 401, 'unauthorized');
    await expectAppError(auth.authenticate(phone.accessToken), 401, 'unauthorized');
    await expectAppError(refresh(phone.refreshToken), 401, 'invalid_refresh_token');
    await expect(auth.listSessions(principal)).resolves.toEqual([]);
    await expect(login()).resolves.toMatchObject({ tokenType: 'Bearer' });
  });

  // S2-F9 (a): the version bump alone is enough, even if a session somehow survived the delete.
  test('after logoutAll an old access token fails on the version bump alone', async () => {
    const { auth, login, refresh } = await setup({ sessions: (inner) => ({ ...inner, deleteAllForOperator: async () => [] }) });
    const pair = await login();
    await auth.logoutAll(await auth.authenticate(pair.accessToken));
    await expectAppError(auth.authenticate(pair.accessToken), 401, 'unauthorized');
    await expectAppError(refresh(pair.refreshToken), 401, 'invalid_refresh_token');
  });

  test('logout ends one session and leaves the others', async () => {
    const { auth, login, refresh } = await setup();
    const laptop = await login();
    const phone = await login();
    await auth.logout(await auth.authenticate(laptop.accessToken));
    await expectAppError(auth.authenticate(laptop.accessToken), 401, 'unauthorized');
    await expectAppError(refresh(laptop.refreshToken), 401, 'invalid_refresh_token');
    await expect(auth.authenticate(phone.accessToken)).resolves.toMatchObject({ kind: 'operator' });
  });

  test('listSessions marks the current one and shows when and where each began', async () => {
    const { auth, login, clock } = await setup();
    const laptop = await login();
    clock.advance(1000);
    await login();
    const principal = await auth.authenticate(laptop.accessToken);
    const sessions = await auth.listSessions(principal);
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s) => s.current).map((s) => s.sessionId)).toEqual([principal.sessionId]);
    expect(sessions[0]).toMatchObject({ createdAt: new Date(clock.now() - 1000).toISOString(), userAgent: 'vitest', ip: '10.0.0.1' });
  });

  // S2-F9 (b)
  test('revokeSession ends your own session and answers 404 for another operator, exactly as for a missing one', async () => {
    const { auth, login } = await setup();
    const laptop = await login();
    const phone = await login();
    const theirs = await login(OTHER_EMAIL, '10.0.0.9');
    const principal = await auth.authenticate(laptop.accessToken);
    const theirSession = (await auth.authenticate(theirs.accessToken)).sessionId;

    const missing = await expectAppError(auth.revokeSession(principal, randomUUID()), 404, 'session_not_found');
    const foreign = await expectAppError(auth.revokeSession(principal, theirSession), 404, 'session_not_found');
    expect(foreign.message).toBe(missing.message);
    await expect(auth.authenticate(theirs.accessToken)).resolves.toMatchObject({ sessionId: theirSession });

    const phoneSession = (await auth.listSessions(principal)).find((s) => !s.current)?.sessionId ?? '';
    await auth.revokeSession(principal, phoneSession);
    await expectAppError(auth.authenticate(phone.accessToken), 401, 'unauthorized');
  });
});

describe('AuthService authenticate', () => {
  // S2-F9 (c): the session is still alive here, so only the tokenVersion check can reject it.
  test('a token with a stale tokenVersion is rejected while its session still exists', async () => {
    const { auth, login, repo, operator, stores } = await setup();
    const pair = await login();
    const principal = await auth.authenticate(pair.accessToken);
    await repo.bumpTokenVersion(operator.id);
    await expect(stores.sessions.get(principal.sessionId)).resolves.not.toBeNull();
    await expectAppError(auth.authenticate(pair.accessToken), 401, 'unauthorized');
  });

  test('garbage, service tokens and tokens without a session are rejected', async () => {
    const { auth, tokens, operator } = await setup();
    await expectAppError(auth.authenticate('not.a.jwt'), 401, 'unauthorized');
    await expectAppError(auth.authenticate(await tokens.signServiceToken({ clientId: 'game', scopes: ['game:economy'] })), 401, 'unauthorized');
    const sessionless = await tokens.signAccessToken({ userId: operator.id, tokenVersion: operator.tokenVersion });
    await expectAppError(auth.authenticate(sessionless), 401, 'unauthorized');
  });

  test('a token whose session belongs to another operator is rejected', async () => {
    const { auth, login, tokens, other } = await setup();
    const mine = await auth.authenticate((await login()).accessToken);
    const forged = await tokens.signAccessToken({ userId: other.id, tokenVersion: other.tokenVersion, sessionId: mine.sessionId });
    await expectAppError(auth.authenticate(forged), 401, 'unauthorized');
  });
});

describe('AuthService fails closed', () => {
  test('login answers 503 auth_unavailable when the session store is down', async () => {
    const { login } = await setup({ sessions: () => brokenSessions });
    await expectAppError(login(), 503, 'auth_unavailable');
  });

  test('login answers 503 auth_unavailable when the limiter store is down, and never checks the password', async () => {
    const { login, hasher } = await setup({ loginStore: () => brokenWindowStore });
    await expectAppError(login(), 503, 'auth_unavailable');
    expect(hasher.verifies).toEqual([]);
  });

  test('refresh answers 503 auth_unavailable when its limiter store is down', async () => {
    const { login, refresh } = await setup({ refreshStore: () => brokenWindowStore });
    await expectAppError(refresh((await login()).refreshToken), 503, 'auth_unavailable');
  });

  test('authenticate and the session routes answer 503 when the session store is down', async () => {
    const holder = { current: undefined as ReturnType<typeof switchable<SessionStore>> | undefined };
    const { auth, login } = await setup({
      sessions: (inner) => {
        holder.current = switchable(inner);
        return holder.current.store;
      },
    });
    const pair = await login();
    const principal = await auth.authenticate(pair.accessToken);
    holder.current?.fail.add('get').add('listForOperator').add('deleteAllForOperator');
    await expectAppError(auth.authenticate(pair.accessToken), 503, 'auth_unavailable');
    await expectAppError(auth.listSessions(principal), 503, 'auth_unavailable');
    await expectAppError(auth.logout(principal), 503, 'auth_unavailable');
    await expectAppError(auth.revokeSession(principal, principal.sessionId), 503, 'auth_unavailable');
    await expectAppError(auth.logoutAll(principal), 503, 'auth_unavailable');
  });

  test('failClosed passes an AppError through and turns anything else into auth_unavailable', async () => {
    const limited = new AppError(429, 'rate_limited', 'slow down');
    await expect(failClosed(() => Promise.reject(limited))).rejects.toBe(limited);
    const wrapped = await expectAppError(failClosed(down), 503, 'auth_unavailable');
    expect(wrapped.message).not.toContain('redis');
    expect(wrapped.cause).toBeInstanceOf(Error);
    await expect(failClosed(async () => 7)).resolves.toBe(7);
  });
});
