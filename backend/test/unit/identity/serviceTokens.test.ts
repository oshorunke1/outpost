import { beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../../../src/app.js';
import { createMemoryAppDeps } from '../../../src/memoryDeps.js';
import type { MemoryApp } from '../../../src/memoryDeps.js';
import { limiterKey, requireService, serviceGuard } from '../../../src/modules/identity/guards.js';
import { TokenBucketLimiter } from '../../../src/modules/identity/limiter/tokenBucket.js';
import { GAME_SCOPES } from '../../../src/modules/identity/scopes.js';
import type { ZodApp } from '../../../src/platform/http.js';
import { createFakeClock } from '../../support/clock.js';
import type { FakeClock } from '../../support/clock.js';
import { bearer, gameToken } from '../../support/tokens.js';

const SECRET = 's'.repeat(43);
const KEY = `opk_game-server.${SECRET}`;

let memory: MemoryApp;
let app: ZodApp;
let clock: FakeClock;

beforeEach(async () => {
  clock = createFakeClock();
  memory = await createMemoryAppDeps({ clock });
  await memory.serviceClients.upsert({ clientId: 'game-server', secretHash: await memory.hasher.hash(SECRET), scopes: GAME_SCOPES });
  app = await buildApp(memory.deps);
  const limiter = new TokenBucketLimiter({ capacity: 2, refillPerSecond: 0.001, clock: createFakeClock() });
  app.get('/test/economy', { onRequest: serviceGuard(memory.deps.serviceTokens, limiter, 'game:economy') }, (request) => ({
    clientId: requireService(request).clientId,
  }));
});

const exchange = (authorization?: string) =>
  app.inject({ method: 'POST', url: '/auth/service-token', headers: authorization ? { authorization } : {} });

describe('service token exchange', () => {
  test('a valid API key buys a 15 minute token with the client scopes', async () => {
    const response = await exchange(`ApiKey ${KEY}`);
    expect(response.statusCode).toBe(200);
    const grant = response.json<{ accessToken: string; scope: string; expiresIn: number }>();
    expect(grant).toMatchObject({ tokenType: 'Bearer', expiresIn: 900, scope: 'game:economy game:telemetry game:flags.read' });
    await expect(memory.deps.serviceTokens.authenticate(grant.accessToken)).resolves.toEqual({
      kind: 'service',
      clientId: 'game-server',
      scopes: [...GAME_SCOPES],
    });
  });

  test('a missing, malformed, unknown, wrong or disabled key is the same 401 with an ApiKey challenge', async () => {
    const wrongSecret = `ApiKey opk_game-server.${'x'.repeat(43)}`;
    const unknownClient = `ApiKey opk_mcp-agent.${SECRET}`;
    const expectInvalid = (response: Awaited<ReturnType<typeof exchange>>) => {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'invalid_api_key', message: 'The API key is not valid' });
      expect(response.headers['www-authenticate']).toBe('ApiKey');
    };
    for (const header of [undefined, 'ApiKey nope', `Bearer ${KEY}`, wrongSecret, unknownClient]) {
      expectInvalid(await exchange(header));
    }
    await memory.serviceClients.setDisabled('game-server', true);
    expectInvalid(await exchange(`ApiKey ${KEY}`));
  });
});

describe('service guard', () => {
  const economy = (headers: Record<string, string> = {}) => app.inject({ method: 'GET', url: '/test/economy', headers });
  const expectUnauthorized = (response: Awaited<ReturnType<typeof economy>>) => {
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'unauthorized' });
    expect(response.headers['www-authenticate']).toBe('Bearer');
  };

  test('lets a scoped game token through and names the client', async () => {
    const response = await economy(bearer(await gameToken(memory.deps.tokens)));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ clientId: 'game-server' });
  });

  test('a token without the scope is 403 insufficient_scope and the body names no scope', async () => {
    const telemetryOnly = await gameToken(memory.deps.tokens, ['game:telemetry']);
    const response = await economy(bearer(telemetryOnly));
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'insufficient_scope', message: 'This token cannot use this route' });
    expect(response.body).not.toContain('game:');
  });

  test('an operator token, a garbage token, a bad scheme or none is 401 with a Bearer challenge', async () => {
    const operator = await memory.deps.tokens.signAccessToken({ userId: 'op-1', tokenVersion: 1, sessionId: 's-1', scopes: [] });
    expectUnauthorized(await economy(bearer(operator)));
    expectUnauthorized(await economy(bearer('not.a.jwt')));
    expectUnauthorized(await economy({ authorization: `ApiKey ${KEY}` }));
    expectUnauthorized(await economy());
  });

  test('a token for a client that is unknown or disabled is 401 once the cache window passes', async () => {
    const ghost = await memory.deps.tokens.signServiceToken({ clientId: 'ghost', scopes: GAME_SCOPES });
    expectUnauthorized(await economy(bearer(ghost)));
    const token = await gameToken(memory.deps.tokens);
    expect((await economy(bearer(token))).statusCode).toBe(200);
    await memory.serviceClients.setDisabled('game-server', true);
    clock.advance(30_000);
    expectUnauthorized(await economy(bearer(token)));
  });

  test('the per-client bucket answers 429 rate_limited with retry-after once spent', async () => {
    const headers = bearer(await gameToken(memory.deps.tokens));
    expect((await economy(headers)).statusCode).toBe(200);
    expect((await economy(headers)).statusCode).toBe(200);
    const limited = await economy(headers);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: 'rate_limited' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  // S4-F5: a bucket group gets its own key, so spending it leaves the default key untouched.
  test('a non default group spends the clientId:group key and leaves the plain clientId key alone', async () => {
    expect(limiterKey('game-server')).toBe('game-server');
    expect(limiterKey('game-server', 'default')).toBe('game-server');
    expect(limiterKey('game-server', 'telemetry')).toBe('game-server:telemetry');

    const shared = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 0.001, clock: createFakeClock() });
    app.get('/test/grouped', { onRequest: serviceGuard(memory.deps.serviceTokens, shared, 'game:telemetry', 'telemetry') }, () => ({ ok: true }));
    const headers = bearer(await gameToken(memory.deps.tokens));
    const grouped = () => app.inject({ method: 'GET', url: '/test/grouped', headers });
    expect((await grouped()).statusCode).toBe(200);
    expect((await grouped()).statusCode).toBe(429);
    expect(shared.allow('game-server')).toBe(true); // the default key still has its token
    expect(shared.allow('game-server:telemetry')).toBe(false);
  });
});
