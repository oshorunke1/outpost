import { Writable } from 'node:stream';
import { beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../../../src/app.js';
import { MEMORY_CONFIG, createMemoryAppDeps } from '../../../src/memoryDeps.js';
import type { MemoryApp } from '../../../src/memoryDeps.js';
import { FLAG_DEFAULTS, createMemoryFlagsService } from '../../../src/modules/flags/flagsService.js';
import type { FlagsService } from '../../../src/modules/flags/flagsService.js';
import type { TelemetryProducer } from '../../../src/modules/telemetry/producer.js';
import { TELEMETRY_FLAGS_TIMEOUT_MS } from '../../../src/modules/telemetry/routes.js';
import { AppError } from '../../../src/platform/errors.js';
import type { ZodApp } from '../../../src/platform/http.js';
import { createFakeClock } from '../../support/clock.js';
import { bearer, gameToken } from '../../support/tokens.js';

const clock = createFakeClock();
let memory: MemoryApp;
let app: ZodApp;
let headers: { authorization: string };

beforeEach(async () => {
  memory = await createMemoryAppDeps({ clock });
  app = await buildApp(memory.deps);
  headers = bearer(await gameToken(memory.deps.tokens));
});

const send = (payload: unknown, auth: Record<string, string> = headers) =>
  app.inject({ method: 'POST', url: '/v1/telemetry/batch', headers: auth, payload: payload as object });

describe('POST /v1/telemetry/batch', () => {
  test('answers 202 and publishes under the calling client', async () => {
    const response = await send({ events: [{ name: 'player_join', ts: clock.now(), userId: 1001 }] });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: 1, dropped: 0 });
    expect(memory.telemetry.published).toEqual([{ source: 'game-server', event: { name: 'player_join', ts: clock.now(), userId: 1001 } }]);
  });

  test('clock skew: out of window events are dropped and counted, and only the kept ones are published', async () => {
    const kept = { name: 'purchase_result', ts: clock.now(), userId: 1001, dims: { outcome: 'Granted', itemId: 'RedHat' } };
    const response = await send({
      events: [kept, { name: 'orb_collected', ts: clock.now() + 3_600_000 }, { name: 'orb_collected', ts: clock.now() - 2 * 86_400_000 }],
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: 1, dropped: 2 });
    expect(memory.telemetry.published).toEqual([{ source: 'game-server', event: kept }]);
  });

  test('a batch where every event is out of window publishes nothing and still answers 202', async () => {
    const response = await send({ events: [{ name: 'orb_collected', ts: clock.now() + 3_600_000 }] });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: 0, dropped: 1 });
    expect(memory.telemetry.published).toEqual([]);
  });

  test('bad batches are refused with invalid_request before anything is published', async () => {
    const ok = { name: 'player_join', ts: clock.now() };
    for (const payload of [
      { events: [{ name: 'nope', ts: clock.now() }] },
      { events: [] },
      { events: [ok], extra: 1 },
      // S4-F4: an item the catalog does not have refuses the whole batch, even next to a good event.
      { events: [ok, { name: 'purchase_result', ts: clock.now(), dims: { outcome: 'Granted', itemId: 'BlueHat' } }] },
      { events: [{ name: 'netguard_drop', ts: clock.now(), dims: { packet: 'Shop.Steal', reason: 'BadPayload' } }] },
    ]) {
      const response = await send(payload);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'invalid_request' });
    }
    expect(memory.telemetry.published).toEqual([]);
  });

  test('a body over 512 KiB is 413 payload_too_large, while one over the app default is accepted', async () => {
    const tooBig = await send({ events: [], pad: 'x'.repeat(600_000) });
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json()).toMatchObject({ error: 'payload_too_large' });

    // 500 events is well over the 16 KiB app wide limit, so this proves the route's own limit applies.
    const full = Array.from({ length: 500 }, () => ({
      name: 'netguard_drop',
      ts: clock.now(),
      userId: 1001,
      dims: { packet: 'Profile.RequestSnapshot', reason: 'TooManyArguments' },
    }));
    expect(JSON.stringify({ events: full }).length).toBeGreaterThan(16 * 1024);
    const big = await send({ events: full });
    expect(big.statusCode).toBe(202);
    expect(big.json()).toEqual({ accepted: 500, dropped: 0 });
    expect(memory.telemetry.published).toHaveLength(500);
  });

  test('needs the game:telemetry scope', async () => {
    const economyOnly = bearer(await gameToken(memory.deps.tokens, ['game:economy']));
    const response = await send({ events: [{ name: 'player_join', ts: clock.now() }] }, economyOnly);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'insufficient_scope' });
    expect(memory.telemetry.published).toEqual([]);
  });

  test('no or a bad token is 401 unauthorized with a Bearer challenge', async () => {
    for (const auth of [{}, { authorization: 'Bearer nope' }] as Record<string, string>[]) {
      const response = await send({ events: [{ name: 'player_join', ts: clock.now() }] }, auth);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: 'unauthorized' });
      expect(response.headers['www-authenticate']).toBe('Bearer');
    }
  });

  test('a producer that fails is 503 telemetry_unavailable', async () => {
    const failing: TelemetryProducer = { publish: async () => Promise.reject(new Error('redis down')) };
    const broken = await createMemoryAppDeps({ clock, overrides: { telemetry: failing } });
    const brokenApp = await buildApp(broken.deps);
    const response = await brokenApp.inject({
      method: 'POST',
      url: '/v1/telemetry/batch',
      headers: bearer(await gameToken(broken.deps.tokens)),
      payload: { events: [{ name: 'player_join', ts: clock.now() }] },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'telemetry_unavailable' });
  });
});

// S4-F5: telemetry spends its own per-client bucket, so a telemetry flood never starves the other routes.
describe('telemetry rate limit group', () => {
  test('a telemetry flood 429s telemetry but default group routes still answer', async () => {
    const limited = await createMemoryAppDeps({
      clock: createFakeClock(),
      overrides: { config: { ...MEMORY_CONFIG, telemetryApiLimit: { capacity: 3, refillPerSecond: 0.001 } } },
    });
    const limitedApp = await buildApp(limited.deps);
    const auth = bearer(await gameToken(limited.deps.tokens));
    const batch = { events: [{ name: 'player_join', ts: limited.clock.now() }] };
    const post = () => limitedApp.inject({ method: 'POST', url: '/v1/telemetry/batch', headers: auth, payload: batch });

    for (let i = 0; i < 3; i += 1) expect((await post()).statusCode).toBe(202);
    const flooded = await post();
    expect(flooded.statusCode).toBe(429);
    expect(flooded.json()).toMatchObject({ error: 'rate_limited' });
    expect(Number(flooded.headers['retry-after'])).toBeGreaterThan(0);

    // The economy route is in the default group: it gets past the limiter and reaches the memory ledger.
    const economy = await limitedApp.inject({ method: 'GET', url: '/v1/players/1001/purchases?unfulfilled=1', headers: auth });
    expect(economy.statusCode).toBe(503);
    expect(economy.json()).toMatchObject({ error: 'ledger_unavailable' });
  });

  test('the default config gives telemetry a bucket of 200 refilling 150 a second', () => {
    expect(MEMORY_CONFIG.telemetryApiLimit).toEqual({ capacity: 200, refillPerSecond: 150 });
  });
});

// S4-F17: TelemetryEnabled switches the route off, and a flags outage never switches it off.
describe('telemetry and the TelemetryEnabled flag', () => {
  const batch = (now: number) => ({ events: [{ name: 'player_join', ts: now }, { name: 'orb_collected', ts: now }] });

  test('with the flag off it answers 202, accepts nothing, counts every event as dropped and publishes nothing', async () => {
    const off = await createMemoryAppDeps({ clock, overrides: { flags: createMemoryFlagsService({ ...FLAG_DEFAULTS, TelemetryEnabled: false }) } });
    const offApp = await buildApp(off.deps);
    const response = await offApp.inject({ method: 'POST', url: '/v1/telemetry/batch', headers: bearer(await gameToken(off.deps.tokens)), payload: batch(clock.now()) });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: 0, dropped: 2 });
    expect(off.telemetry.published).toEqual([]);
  });

  test('when flags are unavailable telemetry fails open, keeps accepting and logs it', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const down: FlagsService = { list: () => Promise.reject(new AppError(503, 'flags_unavailable', 'Flags are temporarily unavailable')) };
    const failing = await createMemoryAppDeps({ clock, overrides: { flags: down } });
    const failingApp = await buildApp({ ...failing.deps, config: { ...MEMORY_CONFIG, logLevel: 'info' } }, { logStream: sink });
    const response = await failingApp.inject({
      method: 'POST',
      url: '/v1/telemetry/batch',
      headers: bearer(await gameToken(failing.deps.tokens)),
      payload: batch(clock.now()),
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: 2, dropped: 0 });
    expect(failing.telemetry.published).toHaveLength(2);
    expect(lines.join('')).toContain('flags unavailable; telemetry stays on');
  });

  test('a slow flags store never holds a batch past the 250 ms bound; it fails open and logs', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    // A store that never answers, like MySQL behind dropped packets.
    const stuck: FlagsService = { list: () => new Promise(() => undefined) };
    const slow = await createMemoryAppDeps({ clock, overrides: { flags: stuck } });
    const slowApp = await buildApp({ ...slow.deps, config: { ...MEMORY_CONFIG, logLevel: 'info' } }, { logStream: sink });
    const started = performance.now();
    const response = await slowApp.inject({ method: 'POST', url: '/v1/telemetry/batch', headers: bearer(await gameToken(slow.deps.tokens)), payload: batch(clock.now()) });
    const elapsed = performance.now() - started;
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: 2, dropped: 0 });
    expect(slow.telemetry.published).toHaveLength(2);
    expect(elapsed).toBeGreaterThanOrEqual(TELEMETRY_FLAGS_TIMEOUT_MS - 20);
    expect(elapsed).toBeLessThan(TELEMETRY_FLAGS_TIMEOUT_MS + 750);
    expect(lines.join('')).toContain('flags lookup took too long; telemetry stays on');
  });

  test('the flags lookup bound is 250 ms', () => {
    expect(TELEMETRY_FLAGS_TIMEOUT_MS).toBe(250);
  });
});
