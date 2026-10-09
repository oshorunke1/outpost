import type { AddressInfo } from 'node:net';
import { describe, expect, test } from 'vitest';
import { buildApp } from '../../../src/app.js';
import { createMemoryAppDeps } from '../../../src/memoryDeps.js';
import { createMetrics, recordWorkerRun, startMetricsServer } from '../../../src/platform/metrics.js';
import { bearer, gameToken } from '../../support/tokens.js';

describe('metrics', () => {
  test('every response is timed by method, route pattern and status', async () => {
    const memory = await createMemoryAppDeps();
    const app = await buildApp(memory.deps);
    await app.inject({ method: 'GET', url: '/healthz' });
    await app.inject({ method: 'GET', url: '/v1/players/1001/wallet' });
    const text = await memory.deps.metrics.registry.metrics();
    expect(text).toContain('http_request_duration_seconds_count{method="GET",route="/healthz",status="200"} 1');
    expect(text).toContain('http_request_duration_seconds_count{method="GET",route="/v1/players/:userId/wallet",status="401"} 1');
  });

  test('an unknown url is labelled unmatched, never by its raw path', async () => {
    const memory = await createMemoryAppDeps();
    const app = await buildApp(memory.deps);
    await app.inject({ method: 'GET', url: '/v1/nope/12345' });
    const text = await memory.deps.metrics.registry.metrics();
    expect(text).toContain('http_request_duration_seconds_count{method="GET",route="unmatched",status="404"} 1');
    expect(text).not.toContain('12345');
  });

  test('the metrics text never carries tokens, keys, ids or emails', async () => {
    const memory = await createMemoryAppDeps();
    const app = await buildApp(memory.deps);
    const token = await gameToken(memory.deps.tokens);
    await app.inject({ method: 'GET', url: '/v1/players/918273/wallet', headers: bearer(token) });
    await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'someone@example.com', password: 'correct horse battery' } });
    await app.inject({ method: 'POST', url: '/auth/service-token', headers: { authorization: 'ApiKey opk_game-server.not-a-real-secret' } });
    const text = await memory.deps.metrics.registry.metrics();
    expect(text).toContain('route="/v1/players/:userId/wallet"');
    for (const leak of ['918273', token, token.split('.')[1] ?? token, '@', 'someone', 'opk_', 'not-a-real-secret', 'Bearer', 'ApiKey']) {
      expect(text).not.toContain(leak);
    }
  });

  test('worker runs are counted by result, including dead_letter', async () => {
    const metrics = createMetrics();
    recordWorkerRun(metrics, { applied: 3, duplicates: 2, malformed: 1, deadLettered: 4 });
    recordWorkerRun(metrics, { applied: 1, duplicates: 0, malformed: 0, deadLettered: 0 });
    const text = await metrics.registry.metrics();
    expect(text).toContain('telemetry_worker_entries_total{result="applied"} 4');
    expect(text).toContain('telemetry_worker_entries_total{result="duplicate"} 2');
    expect(text).toContain('telemetry_worker_entries_total{result="malformed"} 1');
    expect(text).toContain('telemetry_worker_entries_total{result="dead_letter"} 4');
    expect(text).toContain('# TYPE telemetry_stream_length gauge');
    expect(text).toContain('# TYPE telemetry_stream_pending gauge');
  });

  test('default process metrics are opt in', async () => {
    expect(await createMetrics().registry.metrics()).not.toContain('process_cpu_user_seconds_total');
    expect(await createMetrics({ defaultMetrics: true }).registry.metrics()).toContain('process_cpu_user_seconds_total');
  });

  test('the metrics server answers /metrics and nothing else', async () => {
    const metrics = createMetrics();
    const server = await startMetricsServer(metrics.registry, 0, '127.0.0.1');
    try {
      const { port } = server.address() as AddressInfo;
      const ok = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toContain('text/plain');
      expect(await ok.text()).toContain('ledger_transactions_total');
      expect((await fetch(`http://127.0.0.1:${port}/auth/login`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/metrics`, { method: 'POST' })).status).toBe(404);
    } finally {
      server.close();
    }
  });

  test('a port that is already taken rejects instead of hanging', async () => {
    const metrics = createMetrics();
    const first = await startMetricsServer(metrics.registry, 0, '127.0.0.1');
    try {
      const { port } = first.address() as AddressInfo;
      await expect(startMetricsServer(metrics.registry, port, '127.0.0.1')).rejects.toThrow(/EADDRINUSE/);
    } finally {
      first.close();
    }
  });
});
