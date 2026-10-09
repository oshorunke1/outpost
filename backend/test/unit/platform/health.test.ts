import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildApp } from '../../../src/app.js';
import { createMemoryAppDeps } from '../../../src/memoryDeps.js';
import { PROBE_TIMEOUT_MS, READY_CACHE_MS, createHealthChecks } from '../../../src/platform/health.js';
import { createFakeClock } from '../../support/clock.js';

const appWith = async (health: ReturnType<typeof createHealthChecks>) => buildApp((await createMemoryAppDeps({ overrides: { health } })).deps);

afterEach(() => {
  vi.useRealTimers();
});

describe('health', () => {
  // I1: compose relies on the default, so a blackholed MySQL or Redis is a clean 503 within a second.
  test('a probe that never answers fails at PROBE_TIMEOUT_MS by default, not before', async () => {
    vi.useFakeTimers();
    expect(PROBE_TIMEOUT_MS).toBe(1_000);
    const health = createHealthChecks({ slow: () => new Promise(() => undefined) });
    let report: unknown;
    void health.ready().then((value) => {
      report = value;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(report).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(report).toEqual({ ok: false, draining: false, checks: { slow: 'fail' } });
  });

  test('readyz is 200 when every probe passes', async () => {
    const health = createHealthChecks({ mysql: async () => 1, redis: async () => 'PONG' });
    const app = await appWith(health);
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready', checks: { mysql: 'ok', redis: 'ok' } });
  });

  test('a failing or hanging probe makes readyz 503 but healthz stays 200', async () => {
    const health = createHealthChecks(
      { mysql: async () => Promise.reject(new Error('down')), redis: () => new Promise(() => undefined) },
      { timeoutMs: 50 },
    );
    const app = await appWith(health);
    const started = Date.now();
    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: 'not_ready', checks: { mysql: 'fail', redis: 'fail' } });
    const live = await app.inject({ method: 'GET', url: '/healthz' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: 'ok' });
  });

  test('a probe that throws before returning a promise is a fail, not a crash', async () => {
    const health = createHealthChecks({
      mysql: () => {
        throw new Error('sync boom');
      },
    });
    await expect(health.ready()).resolves.toMatchObject({ ok: false, checks: { mysql: 'fail' } });
  });

  test('a burst of readiness checks makes one probe per dependency, and the report is cached about a second', async () => {
    const clock = createFakeClock();
    const calls = { mysql: 0, redis: 0 };
    const health = createHealthChecks(
      {
        mysql: async () => {
          calls.mysql += 1;
          return 1;
        },
        redis: async () => {
          calls.redis += 1;
          return 'PONG';
        },
      },
      { clock },
    );
    const app = await appWith(health);
    const burst = await Promise.all(Array.from({ length: 25 }, () => app.inject({ method: 'GET', url: '/readyz' })));
    expect(burst.every((response) => response.statusCode === 200)).toBe(true);
    expect(calls).toEqual({ mysql: 1, redis: 1 });

    clock.advance(READY_CACHE_MS - 1);
    await app.inject({ method: 'GET', url: '/readyz' });
    expect(calls).toEqual({ mysql: 1, redis: 1 });

    clock.advance(1);
    await app.inject({ method: 'GET', url: '/readyz' });
    expect(calls).toEqual({ mysql: 2, redis: 2 });
  });

  test('a failing report is cached too, so an outage is not probed on every request', async () => {
    const clock = createFakeClock();
    let calls = 0;
    const health = createHealthChecks(
      {
        mysql: async () => {
          calls += 1;
          throw new Error('down');
        },
      },
      { clock },
    );
    expect((await health.ready()).ok).toBe(false);
    expect((await health.ready()).ok).toBe(false);
    expect(calls).toBe(1);
  });

  test('draining flips readyz to 503 draining without probing, and healthz stays 200', async () => {
    let calls = 0;
    const health = createHealthChecks({
      mysql: async () => {
        calls += 1;
        return 1;
      },
    });
    const app = await appWith(health);
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    health.setDraining();
    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: 'draining', checks: {} });
    expect(calls).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });

  test('healthz never touches a dependency', async () => {
    let calls = 0;
    const health = createHealthChecks({
      mysql: async () => {
        calls += 1;
        return 1;
      },
    });
    const app = await appWith(health);
    await app.inject({ method: 'GET', url: '/healthz' });
    expect(calls).toBe(0);
  });
});
