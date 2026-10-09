import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { ZodApp } from '../../src/platform/http.js';
import { connectRedis } from '../../src/platform/redis.js';
import { createIntegrationApp, seedOperator } from './support/app.js';
import { createIntegrationContext } from './support/context.js';
import type { IntegrationContext } from './support/context.js';

const EMAIL = 'operator@outpost.local';
const PASSWORD = 'pw-1-correct-horse';

describe('identity over HTTP on MySQL and Redis', () => {
  let ctx: IntegrationContext;
  let app: ZodApp;
  beforeAll(async () => {
    ctx = await createIntegrationContext();
    ({ app } = await createIntegrationApp(ctx));
    await seedOperator(ctx, EMAIL, PASSWORD);
  });
  afterAll(async () => {
    await app.close();
    await ctx.close();
  });

  const login = (ip: string) =>
    app.inject({ method: 'POST', url: '/auth/login', payload: { email: EMAIL, password: PASSWORD }, remoteAddress: ip });
  const refresh = (refreshToken: string) => app.inject({ method: 'POST', url: '/auth/token/refresh', payload: { refreshToken } });

  test('login, rotate, detect reuse, then the family is dead', async () => {
    const first = (await login('10.0.0.1')).json<{ refreshToken: string }>();
    const second = await refresh(first.refreshToken);
    expect(second.statusCode).toBe(200);
    const replay = await refresh(first.refreshToken);
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ error: 'refresh_token_reused' });
    const afterReplay = await refresh(second.json<{ refreshToken: string }>().refreshToken);
    expect(afterReplay.statusCode).toBe(401);
    expect(afterReplay.json()).toMatchObject({ error: 'invalid_refresh_token' });
  });

  test('sessions are listed from Redis and one can be revoked by id', async () => {
    const mine = (await login('10.0.0.2')).json<{ accessToken: string }>();
    const other = (await login('10.0.0.3')).json<{ accessToken: string }>();
    const headers = { authorization: `Bearer ${mine.accessToken}` };
    const listed = (await app.inject({ method: 'GET', url: '/auth/sessions', headers })).json<{
      sessions: { sessionId: string; ip: string; current: boolean }[];
    }>();
    const target = listed.sessions.find((s) => s.ip === '10.0.0.3');
    expect(target).toBeDefined();
    const revoked = await app.inject({ method: 'DELETE', url: `/auth/sessions/${target?.sessionId}`, headers });
    expect(revoked.statusCode).toBe(204);
    const theirs = await app.inject({ method: 'GET', url: '/auth/sessions', headers: { authorization: `Bearer ${other.accessToken}` } });
    expect(theirs.statusCode).toBe(401);
    expect(theirs.json()).toMatchObject({ error: 'unauthorized' });
  });

  test('logout/all kills every access token at once', async () => {
    const a = (await login('10.0.0.4')).json<{ accessToken: string }>();
    const b = (await login('10.0.0.5')).json<{ accessToken: string }>();
    const all = await app.inject({ method: 'POST', url: '/auth/logout/all', headers: { authorization: `Bearer ${a.accessToken}` } });
    expect(all.statusCode).toBe(204);
    for (const token of [a.accessToken, b.accessToken]) {
      const response = await app.inject({ method: 'GET', url: '/auth/sessions', headers: { authorization: `Bearer ${token}` } });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: 'unauthorized' });
    }
  });

  test('the login limiter counts in Redis and answers 429 with Retry-After', async () => {
    const wrong = () =>
      app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'nobody@outpost.local', password: 'x' }, remoteAddress: '10.9.9.9' });
    for (let i = 0; i < 5; i++) {
      const response = await wrong();
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: 'invalid_credentials' });
    }
    const blocked = await wrong();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: 'rate_limited' });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    await expect(ctx.redis.keys('ratelimit:login:ipaccount:*')).resolves.not.toHaveLength(0);
  });

  test('login fails closed with 503 when Redis is unreachable', async () => {
    const broken = await connectRedis(process.env.TEST_REDIS_URL ?? '');
    const { app: brokenApp } = await createIntegrationApp(ctx, { redis: broken });
    broken.disconnect();
    try {
      const response = await brokenApp.inject({ method: 'POST', url: '/auth/login', payload: { email: EMAIL, password: PASSWORD } });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: 'auth_unavailable', message: 'Authentication is temporarily unavailable' });
    } finally {
      await brokenApp.close();
    }
  });

  test('the JWKS served by the real wiring has no private members', async () => {
    const response = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    expect(response.statusCode).toBe(200);
    const { keys } = response.json<{ keys: Record<string, unknown>[] }>();
    expect(keys).toHaveLength(1);
    for (const member of ['d', 'p', 'q']) expect(keys[0]).not.toHaveProperty(member);
  });
});
