import { context } from '@opentelemetry/api';
import { RPCType, getRPCMetadata } from '@opentelemetry/core';
import type { ZodApp } from './http.js';

// The auto instrumentations have no Fastify instrumentation any more, so the HTTP server span would
// be named after the method alone ("POST"). instrumentation-http leaves an RPC metadata object on
// each request's context and, when the response ends, copies its route into http.route, on the span
// and on the request duration metric, and renames the span "POST /v1/economy/transactions". This
// hook fills that route with Fastify's route pattern, so ids in the URL never reach a span name or
// a metric label. A request that matched no route keeps the method only. Without tracing (tests,
// OTEL_TRACES_EXPORTER=none) there is no metadata and the hook does nothing.
export function registerRouteTracing(app: ZodApp): void {
  app.addHook('onRequest', async (request) => {
    const metadata = getRPCMetadata(context.active());
    const route = request.routeOptions.url;
    if (metadata?.type === RPCType.HTTP && route) metadata.route = route;
  });
}
