import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mainDemo, runDemo, waitForReady } from '../../scripts/demoFlow.js';
import type { DemoConfig } from '../../scripts/demoFlow.js';
import { FAST_ARGON2, createArgon2Hasher } from '../../src/modules/identity/crypto/password.js';
import { seedDev } from '../../src/modules/identity/seed.js';
import { systemClock } from '../../src/platform/clock.js';
import type { ZodApp } from '../../src/platform/http.js';
import { createIntegrationApp } from './support/app.js';
import { createIntegrationContext } from './support/context.js';
import type { IntegrationContext } from './support/context.js';

// The demo over a real socket against the real composition root on MySQL and Redis, with the key
// stored the way the dev seed stores it. The live Compose run is in the task report.
describe('pnpm demo against the real app', () => {
  let ctx: IntegrationContext;
  let app: ZodApp;
  let baseUrl: string;
  const apiKey = `opk_game-server.${randomBytes(32).toString('base64url')}`;
  beforeAll(async () => {
    ctx = await createIntegrationContext();
    ({ app } = await createIntegrationApp(ctx));
    await seedDev({ db: ctx.db, clock: systemClock, hasher: createArgon2Hasher(FAST_ARGON2), nodeEnv: 'test', apiKey });
    await app.listen({ host: '127.0.0.1', port: 0 });
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app.close();
    await ctx.close();
  });

  const config = (userId: number): DemoConfig => ({ baseUrl, apiKey, userId, userIdSource: 'env', jaegerUrl: 'http://localhost:16686' });
  const quiet = { fetch: (url: string, init?: RequestInit) => fetch(url, init), log: () => undefined };

  test('readyz is ready', async () => {
    await expect(waitForReady({ baseUrl, fetch, sleep: (ms) => sleep(ms), now: Date.now, timeoutMs: 5_000 })).resolves.toMatchObject({ status: 'ready' });
  });

  test('runs twice in a row for the same player, the second starting where the first ended', async () => {
    const first = await runDemo(config(31337), quiet);
    expect(first).toEqual({ userId: 31337, startBalance: 0, endBalance: 5 });
    const second = await runDemo(config(31337), quiet);
    expect(second).toEqual({ userId: 31337, startBalance: 5, endBalance: 10 });
  });

  test('main runs end to end with a random player and exits 0', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await mainDemo(
      { OUTPOST_BACKEND_URL: baseUrl, OUTPOST_GAME_API_KEY: apiKey },
      { fetch, sleep: (ms) => sleep(ms), now: Date.now, log: (line) => out.push(line), error: (line) => err.push(line) },
    );
    expect({ code, err }).toEqual({ code: 0, err: [] });
    expect(out.filter((line) => line.startsWith('ok   '))).toHaveLength(16);
    expect(out.join('\n')).toMatch(/try the Gold Crown with 5 Coins, which is refused -> 422 \{"error":"insufficient_funds"\}/);
    expect(out.join('\n')).not.toContain(apiKey);
  });

  test('a wrong key stops at the exchange with a clear 401', async () => {
    const wrong = `opk_game-server.${randomBytes(32).toString('base64url')}`;
    await expect(runDemo({ ...config(424242), apiKey: wrong }, quiet)).rejects.toThrow(
      /trade the game API key for a 15 minute scoped token: expected HTTP 200, got 401 invalid_api_key \(.+\)\. Check that OUTPOST_GAME_API_KEY/,
    );
  });
});
