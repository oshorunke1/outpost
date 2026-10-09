import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { ROOT_CONTEXT, SpanKind, context, metrics, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { RPCType, setRPCMetadata } from '@opentelemetry/core';
import type { RPCMetadata } from '@opentelemetry/core';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../../src/app.js';
import { createMemoryAppDeps } from '../../../src/memoryDeps.js';
import type { ZodApp } from '../../../src/platform/http.js';
import { bearer, gameToken } from '../../support/tokens.js';

// A reader that only collects when asked, so the test can read the HTTP duration metric.
class TestReader extends MetricReader {
  protected override async onForceFlush(): Promise<void> {}
  protected override async onShutdown(): Promise<void> {}
}

const contextManager = new AsyncLocalStorageContextManager();
let app: ZodApp;
let auth: { authorization: string };

beforeAll(async () => {
  context.setGlobalContextManager(contextManager.enable());
  const memory = await createMemoryAppDeps();
  app = await buildApp(memory.deps);
  auth = bearer(await gameToken(memory.deps.tokens));
});

afterAll(async () => {
  await app.close();
  context.disable();
});

describe('route names for the HTTP server span', () => {
  // instrumentation-http puts this object on the request's context and reads .route back when the
  // response ends. Here the test plays that part.
  const traced = async (method: 'GET' | 'POST', url: string) => {
    const meta: RPCMetadata = { type: RPCType.HTTP, span: trace.wrapSpanContext({ traceId: '1'.repeat(32), spanId: '1'.repeat(16), traceFlags: 1 }) };
    // inject only starts the request when it is awaited, so await it inside the context.
    const response = await context.with(setRPCMetadata(ROOT_CONTEXT, meta), async () => await app.inject({ method, url, headers: auth }));
    return { meta, status: response.statusCode };
  };

  test('a matched route sets the pattern, never the raw id', async () => {
    const { meta, status } = await traced('POST', '/v1/players/123/sessions');
    expect(status).toBe(200);
    expect(meta.route).toBe('/v1/players/:userId/sessions');
  });

  test('a request that matched no route leaves it unset', async () => {
    const { meta, status } = await traced('GET', '/no/such/route/123');
    expect(status).toBe(404);
    expect(meta.route).toBeUndefined();
  });

  test('a request outside any trace context is left alone', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
  });
});

describe('with the real HTTP instrumentation and a live socket', () => {
  const spans = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] });
  const reader = new TestReader();
  const meterProvider = new MeterProvider({ readers: [reader] });
  const instrumentation = new HttpInstrumentation({ enabled: false });
  // In production the require hook patches http when it loads. Under vitest the module is long
  // loaded, so the test applies the instrumentation's own http patch directly, and removes it after.
  const http = createRequire(import.meta.url)('node:http') as unknown;
  const httpPatch = instrumentation.getModuleDefinitions().find((definition) => definition.name === 'http');
  let live: ZodApp;
  let baseUrl: string;
  let liveAuth: { authorization: string };

  beforeAll(async () => {
    trace.setGlobalTracerProvider(tracerProvider);
    metrics.setGlobalMeterProvider(meterProvider);
    instrumentation.setTracerProvider(tracerProvider);
    instrumentation.setMeterProvider(meterProvider);
    httpPatch?.patch?.(http);
    const memory = await createMemoryAppDeps();
    live = await buildApp(memory.deps);
    liveAuth = bearer(await gameToken(memory.deps.tokens));
    await live.listen({ host: '127.0.0.1', port: 0 });
    baseUrl = `http://127.0.0.1:${(live.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await live.close();
    httpPatch?.unpatch?.(http);
    await tracerProvider.shutdown();
    await meterProvider.shutdown();
    trace.disable();
    metrics.disable();
  });

  test('the server span and the duration metric carry the route pattern', async () => {
    const response = await fetch(`${baseUrl}/v1/players/4567/sessions`, { method: 'POST', headers: liveAuth });
    expect(response.status).toBe(200);
    await fetch(`${baseUrl}/v1/economy/transactions`, { method: 'POST', headers: { ...liveAuth, 'content-type': 'application/json', 'idempotency-key': 'trace-test-1' }, body: '{}' });

    const server = spans.getFinishedSpans().filter((span) => span.kind === SpanKind.SERVER);
    const names = server.map((span) => span.name);
    expect(names).toEqual(expect.arrayContaining(['POST /v1/players/:userId/sessions', 'POST /v1/economy/transactions']));
    expect(names.join(' ')).not.toContain('4567');
    const join = server.find((span) => span.name === 'POST /v1/players/:userId/sessions');
    expect(join?.attributes['http.route']).toBe('/v1/players/:userId/sessions');

    const { resourceMetrics } = await reader.collect();
    const duration = resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics).find((metric) => metric.descriptor.name === 'http.server.request.duration');
    const routes = (duration?.dataPoints ?? []).map((point) => point.attributes['http.route']);
    expect(routes).toEqual(expect.arrayContaining(['/v1/players/:userId/sessions', '/v1/economy/transactions']));
    expect(routes.join(' ')).not.toContain('4567');
  });
});
