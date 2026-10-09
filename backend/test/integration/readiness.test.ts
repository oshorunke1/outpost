import { expect, test } from 'vitest';
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
