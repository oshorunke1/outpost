import { describe, expect, test } from 'vitest';
import { buildApp } from '../../../src/app.js';
import { MEMORY_CONFIG, createMemoryAppDeps } from '../../../src/memoryDeps.js';
import { FLAG_DEFAULTS, createMemoryFlagsService, createMysqlFlagsService } from '../../../src/modules/flags/flagsService.js';
import type { Db } from '../../../src/platform/db.js';
import { createFakeClock } from '../../support/clock.js';
import { bearer, gameToken } from '../../support/tokens.js';

// A pool stand-in whose every query fails, like MySQL being down.
const downDb = { query: () => Promise.reject(new Error('connect ECONNREFUSED')) } as unknown as Db;
const quietLogger = { warn: () => undefined };

describe('GET /v1/flags', () => {
  test('serves the flags to a game token with game:flags.read', async () => {
    const memory = await createMemoryAppDeps();
    const app = await buildApp(memory.deps);
    const ok = await app.inject({ method: 'GET', url: '/v1/flags', headers: bearer(await gameToken(memory.deps.tokens)) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ flags: FLAG_DEFAULTS });
  });

  test('a token without game:flags.read is 403 insufficient_scope', async () => {
    const memory = await createMemoryAppDeps();
    const app = await buildApp(memory.deps);
    const noScope = await app.inject({ method: 'GET', url: '/v1/flags', headers: bearer(await gameToken(memory.deps.tokens, ['game:economy'])) });
    expect(noScope.statusCode).toBe(403);
    expect(noScope.json()).toMatchObject({ error: 'insufficient_scope' });
  });

  test('no token is 401 with the Bearer challenge', async () => {
    const memory = await createMemoryAppDeps();
    const app = await buildApp(memory.deps);
    const anonymous = await app.inject({ method: 'GET', url: '/v1/flags' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers['www-authenticate']).toBe('Bearer');
    expect(anonymous.json()).toMatchObject({ error: 'unauthorized' });
  });

  test('serves whatever the flags service holds', async () => {
    const memory = await createMemoryAppDeps({ overrides: { flags: createMemoryFlagsService({ ...FLAG_DEFAULTS, ShopEnabled: false }) } });
    const app = await buildApp(memory.deps);
    const ok = await app.inject({ method: 'GET', url: '/v1/flags', headers: bearer(await gameToken(memory.deps.tokens)) });
    expect(ok.json()).toEqual({ flags: { ...FLAG_DEFAULTS, ShopEnabled: false } });
  });

  test('a cold cache and a failing store is 503 flags_unavailable with Retry-After', async () => {
    const flags = createMysqlFlagsService(downDb, createFakeClock(), { logger: quietLogger });
    const memory = await createMemoryAppDeps({ overrides: { flags } });
    const app = await buildApp(memory.deps);
    const down = await app.inject({ method: 'GET', url: '/v1/flags', headers: bearer(await gameToken(memory.deps.tokens)) });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toEqual({ error: 'flags_unavailable', message: 'Flags are temporarily unavailable' });
    expect(down.headers['retry-after']).toBe('1');
    expect(down.body).not.toContain('ECONNREFUSED');
  });
});

// M1: /v1/flags spends the default bucket, so a telemetry flood never 429s the flags poll.
describe('flags rate limit group', () => {
  test('a telemetry flood 429s telemetry while /v1/flags still answers', async () => {
    const limited = await createMemoryAppDeps({
      clock: createFakeClock(),
      overrides: { config: { ...MEMORY_CONFIG, telemetryApiLimit: { capacity: 2, refillPerSecond: 0.001 } } },
    });
    const app = await buildApp(limited.deps);
    const auth = bearer(await gameToken(limited.deps.tokens));
    const batch = { events: [{ name: 'player_join', ts: limited.clock.now() }] };
    const post = () => app.inject({ method: 'POST', url: '/v1/telemetry/batch', headers: auth, payload: batch });
    for (let i = 0; i < 2; i += 1) expect((await post()).statusCode).toBe(202);
    expect((await post()).statusCode).toBe(429);

    const flags = await app.inject({ method: 'GET', url: '/v1/flags', headers: auth });
    expect(flags.statusCode).toBe(200);
    expect(flags.json()).toEqual({ flags: FLAG_DEFAULTS });
  });
});

describe('memory flags service', () => {
  test('hands out copies, so a caller cannot change what the next caller sees', async () => {
    const flags = createMemoryFlagsService();
    const first = await flags.list();
    first.ShopEnabled = false;
    await expect(flags.list()).resolves.toEqual(FLAG_DEFAULTS);
  });
});
