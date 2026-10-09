import { expect, test } from 'vitest';
import { probeDb } from '../../src/platform/db.js';
import { PROBE_TIMEOUT_MS } from '../../src/platform/health.js';
import { createIntegrationApp } from './support/app.js';
import { createIntegrationContext } from './support/context.js';

test('the composed app reports MySQL and Redis ready, and its metrics registry times the call', async () => {
  const ctx = await createIntegrationContext();
  const { app, deps } = await createIntegrationApp(ctx);
  try {
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready', checks: { mysql: 'ok', redis: 'ok' } });
    expect(await deps.metrics.registry.metrics()).toContain('http_request_duration_seconds_count{method="GET",route="/readyz",status="200"} 1');
  } finally {
    await app.close();
    await ctx.close();
  }
});

test('a dead MySQL makes the composed readyz 503 with mysql fail', async () => {
  const ctx = await createIntegrationContext();
  const deadDb = { query: async () => Promise.reject(new Error('connect ECONNREFUSED')) } as unknown as typeof ctx.db;
  const { app } = await createIntegrationApp(ctx, { db: deadDb });
  try {
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready', checks: { mysql: 'fail', redis: 'ok' } });
  } finally {
    await app.close();
    await ctx.close();
  }
});

// M1: the MySQL probe carries a query timeout, so a hung database gives its pool connection back
// instead of holding it until TCP gives up.
test('the composed MySQL probe asks for a query timeout of PROBE_TIMEOUT_MS', async () => {
  const ctx = await createIntegrationContext();
  const sent: unknown[] = [];
  const spying = new Proxy(ctx.db, {
    get(target, property) {
      if (property === 'query') {
        return (...args: unknown[]) => {
          sent.push(args[0]);
          return (target.query as (...rest: unknown[]) => unknown)(...args);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? (value as (...rest: unknown[]) => unknown).bind(target) : value;
    },
  });
  const { app } = await createIntegrationApp(ctx, { db: spying });
  try {
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    expect(sent).toContainEqual({ sql: 'SELECT 1', timeout: PROBE_TIMEOUT_MS });
  } finally {
    await app.close();
    await ctx.close();
  }
});

test('mysql2 enforces the probe timeout on a slow query and the pool keeps serving', async () => {
  const ctx = await createIntegrationContext();
  try {
    const started = Date.now();
    await expect(ctx.db.query({ sql: 'SELECT SLEEP(3)', timeout: 100 })).rejects.toMatchObject({ code: 'PROTOCOL_SEQUENCE_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(1_500);
    await expect(probeDb(ctx.db, PROBE_TIMEOUT_MS)).resolves.toBeUndefined();
  } finally {
    await ctx.close();
  }
});
