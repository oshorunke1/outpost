import { describe, expect, test } from 'vitest';
import { FAST_ARGON2, createArgon2Hasher, makeDummyHash } from '../../../src/modules/identity/crypto/password.js';
import type { PasswordHasher } from '../../../src/modules/identity/crypto/password.js';
import { createTokenService, generateKeyPair } from '../../../src/modules/identity/crypto/tokenService.js';
import { SERVICE_TOKEN_IP_FAILURE_LIMIT, SERVICE_TOKEN_LIMIT } from '../../../src/modules/identity/limiter/loginLimiter.js';
import { SlidingWindowCounter, createMemoryWindowStore } from '../../../src/modules/identity/limiter/slidingWindow.js';
import type { WindowStore } from '../../../src/modules/identity/limiter/slidingWindow.js';
import { createMemoryServiceClientRepo } from '../../../src/modules/identity/repos/serviceClientRepo.js';
import type { ServiceClientRepo } from '../../../src/modules/identity/repos/serviceClientRepo.js';
import { GAME_SCOPES } from '../../../src/modules/identity/scopes.js';
import { CLIENT_CACHE_MS, createServiceTokenService } from '../../../src/modules/identity/services/serviceTokenService.js';
import { AppError } from '../../../src/platform/errors.js';
import { createFakeClock } from '../../support/clock.js';

const SECRET = 'g'.repeat(43);
const VALID = `ApiKey opk_game-server.${SECRET}`;
const WRONG = `ApiKey opk_game-server.${'w'.repeat(43)}`;
const down = async (): Promise<never> => Promise.reject(new Error('redis down'));

async function setup(options: { ipStore?: WindowStore; clientStore?: WindowStore; clients?: ServiceClientRepo } = {}) {
  const clock = createFakeClock();
  const real = createArgon2Hasher(FAST_ARGON2);
  // Counts every verify and remembers which stored hash it ran against.
  const verifiedAgainst: string[] = [];
  const hasher: PasswordHasher = {
    hash: (plain) => real.hash(plain),
    async verify(stored, plain) {
      verifiedAgainst.push(stored);
      return real.verify(stored, plain);
    },
  };
  const dummyHash = await makeDummyHash(real);
  const clients = options.clients ?? createMemoryServiceClientRepo();
  const secretHash = await real.hash(SECRET);
  if (!options.clients) await clients.upsert({ clientId: 'game-server', secretHash, scopes: GAME_SCOPES });
  const tokens = createTokenService(await generateKeyPair(), { now: () => clock.now() });
  const counter = (limits: { limit: number; windowMs: number }, store?: WindowStore) =>
    new SlidingWindowCounter({ ...limits, clock, store: store ?? createMemoryWindowStore() });
  const service = createServiceTokenService({
    clients,
    tokens,
    hasher,
    dummyHash,
    clock,
    perClient: counter(SERVICE_TOKEN_LIMIT, options.clientStore),
    ipFailures: counter(SERVICE_TOKEN_IP_FAILURE_LIMIT, options.ipStore),
  });
  return { clock, clients, tokens, service, verifiedAgainst, dummyHash, secretHash };
}

async function caught(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof AppError)) throw new Error(`expected an AppError, got ${String(error)}`);
  return error;
}

function expectInvalidKey(error: AppError) {
  expect(error).toMatchObject({ statusCode: 401, code: 'invalid_api_key' });
  expect(error.headers).toEqual({ 'www-authenticate': 'ApiKey' });
}

function expectRateLimited(error: AppError) {
  expect(error).toMatchObject({ statusCode: 429, code: 'rate_limited' });
  expect(Number(error.headers['retry-after'])).toBeGreaterThan(0);
}

describe('exchange timing parity', () => {
  test('an unknown client id still runs exactly one verify, against the dummy hash', async () => {
    const { service, verifiedAgainst, dummyHash } = await setup();
    expectInvalidKey(await caught(service.exchange({ authorization: `ApiKey opk_mcp-agent.${SECRET}`, ip: '10.0.0.1' })));
    expect(verifiedAgainst).toEqual([dummyHash]);
  });

  test('a wrong secret runs exactly one verify, against the stored hash', async () => {
    const { service, verifiedAgainst, secretHash } = await setup();
    expectInvalidKey(await caught(service.exchange({ authorization: WRONG, ip: '10.0.0.1' })));
    expect(verifiedAgainst).toEqual([secretHash]);
  });

  test('a disabled client still runs one verify and gets the same 401, even with the right secret', async () => {
    const { service, clients, verifiedAgainst, secretHash } = await setup();
    await clients.setDisabled('game-server', true);
    expectInvalidKey(await caught(service.exchange({ authorization: VALID, ip: '10.0.0.1' })));
    expect(verifiedAgainst).toEqual([secretHash]);
  });

  test('a malformed header is a 401 without any hash work', async () => {
    const { service, verifiedAgainst } = await setup();
    expectInvalidKey(await caught(service.exchange({ authorization: 'ApiKey nope', ip: '10.0.0.1' })));
    expectInvalidKey(await caught(service.exchange({ authorization: undefined, ip: '10.0.0.1' })));
    expect(verifiedAgainst).toEqual([]);
  });
});

describe('exchange rate limits (S3-F6)', () => {
  test('31 failed keys for the game client from 31 IPs do not block the real game server', async () => {
    const { service } = await setup();
    for (let i = 1; i <= 31; i += 1) {
      expectInvalidKey(await caught(service.exchange({ authorization: WRONG, ip: `10.0.0.${i}` })));
    }
    await expect(service.exchange({ authorization: VALID, ip: '203.0.113.7' })).resolves.toMatchObject({ tokenType: 'Bearer' });
  });

  test('the per-client bucket counts verified exchanges only, and the 31st in a minute is 429', async () => {
    const { service } = await setup();
    for (let i = 1; i <= SERVICE_TOKEN_LIMIT.limit; i += 1) {
      await expect(service.exchange({ authorization: VALID, ip: `10.1.0.${i}` })).resolves.toMatchObject({ tokenType: 'Bearer' });
    }
    expectRateLimited(await caught(service.exchange({ authorization: VALID, ip: '10.1.1.1' })));
  });

  test('an IP that keeps failing is refused with 429 before any hash work, valid key or not', async () => {
    const { service, verifiedAgainst, clock } = await setup();
    for (let i = 0; i < SERVICE_TOKEN_IP_FAILURE_LIMIT.limit; i += 1) {
      expectInvalidKey(await caught(service.exchange({ authorization: WRONG, ip: '10.0.0.9' })));
    }
    verifiedAgainst.length = 0;
    expectRateLimited(await caught(service.exchange({ authorization: VALID, ip: '10.0.0.9' })));
    expectRateLimited(await caught(service.exchange({ authorization: 'ApiKey nope', ip: '10.0.0.9' })));
    expect(verifiedAgainst).toEqual([]);
    // Other IPs are unaffected, and the blocked IP recovers once its failures age out.
    await expect(service.exchange({ authorization: VALID, ip: '10.0.0.10' })).resolves.toMatchObject({ tokenType: 'Bearer' });
    clock.advance(SERVICE_TOKEN_IP_FAILURE_LIMIT.windowMs * 2);
    await expect(service.exchange({ authorization: VALID, ip: '10.0.0.9' })).resolves.toMatchObject({ tokenType: 'Bearer' });
  });

  test('successful exchanges never count against the IP', async () => {
    const { service } = await setup();
    for (let i = 0; i < SERVICE_TOKEN_IP_FAILURE_LIMIT.limit + 5; i += 1) {
      await expect(service.exchange({ authorization: VALID, ip: '10.0.0.20' })).resolves.toMatchObject({ tokenType: 'Bearer' });
    }
  });

  test('a broken limiter store or client repo fails closed with 503 auth_unavailable', async () => {
    const brokenStore: WindowStore = { increment: down, read: down };
    for (const options of [{ ipStore: brokenStore }, { clientStore: brokenStore }]) {
      const { service } = await setup(options);
      expect(await caught(service.exchange({ authorization: VALID, ip: '10.0.0.1' }))).toMatchObject({
        statusCode: 503,
        code: 'auth_unavailable',
      });
    }
    const brokenRepo: ServiceClientRepo = { findById: down, upsert: down, setDisabled: down };
    const { service } = await setup({ clients: brokenRepo });
    expect(await caught(service.exchange({ authorization: VALID, ip: '10.0.0.1' }))).toMatchObject({
      statusCode: 503,
      code: 'auth_unavailable',
    });
  });
});

describe('authenticate (S3-F7)', () => {
  test('a disabled client is cut off once the cache window passes, on the injected clock', async () => {
    const { service, clients, clock } = await setup();
    const { accessToken } = await service.exchange({ authorization: VALID, ip: '10.0.0.1' });
    await expect(service.authenticate(accessToken)).resolves.toMatchObject({ kind: 'service', clientId: 'game-server' });
    await clients.setDisabled('game-server', true);
    clock.advance(CLIENT_CACHE_MS - 1);
    await expect(service.authenticate(accessToken)).resolves.toMatchObject({ clientId: 'game-server' }); // still cached
    clock.advance(1);
    expect(await caught(service.authenticate(accessToken))).toMatchObject({ statusCode: 401, code: 'unauthorized' });
    await clients.setDisabled('game-server', false);
    clock.advance(CLIENT_CACHE_MS);
    await expect(service.authenticate(accessToken)).resolves.toMatchObject({ clientId: 'game-server' });
  });

  test('the cache window is at most 30 seconds', () => {
    expect(CLIENT_CACHE_MS).toBeGreaterThan(0);
    expect(CLIENT_CACHE_MS).toBeLessThanOrEqual(30_000);
  });

  test('a token for an unknown client, an operator token or garbage is 401 unauthorized', async () => {
    const { service, tokens } = await setup();
    const ghost = await tokens.signServiceToken({ clientId: 'ghost', scopes: GAME_SCOPES });
    const operator = await tokens.signAccessToken({ userId: 'op-1', tokenVersion: 1 });
    for (const token of [ghost, operator, 'garbage', '']) {
      expect(await caught(service.authenticate(token))).toMatchObject({ statusCode: 401, code: 'unauthorized' });
    }
  });

  test('a client repo failure during authenticate is 503 auth_unavailable', async () => {
    const brokenRepo: ServiceClientRepo = { findById: down, upsert: down, setDisabled: down };
    const { service, tokens } = await setup({ clients: brokenRepo });
    const token = await tokens.signServiceToken({ clientId: 'game-server', scopes: GAME_SCOPES });
    expect(await caught(service.authenticate(token))).toMatchObject({ statusCode: 503, code: 'auth_unavailable' });
  });
});
