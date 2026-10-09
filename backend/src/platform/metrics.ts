import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';
import type { ZodApp } from './http.js';

export interface Metrics {
  registry: Registry;
  httpDuration: Histogram<'method' | 'route' | 'status'>;
  // outcome is created, replayed, an AppError code (a fixed vocabulary) or error.
  ledgerTransactions: Counter<'kind' | 'outcome'>;
  idempotentReplays: Counter;
  telemetryAccepted: Counter;
  // reason is clock_skew (outside the accepted window) or disabled (TelemetryEnabled off).
  telemetryDropped: Counter<'reason'>;
  // result is applied, duplicate, malformed or dead_letter.
  workerEntries: Counter<'result'>;
  streamPending: Gauge;
  streamLength: Gauge;
}

// The worker's per-run totals, as createTelemetryWorker returns them.
export interface WorkerRunCounts {
  applied: number;
  duplicates: number;
  malformed: number;
  deadLettered: number;
}

// One registry per process (or per test), so tests never see each other's numbers.
export function createMetrics(options: { defaultMetrics?: boolean } = {}): Metrics {
  const registry = new Registry();
  if (options.defaultMetrics) collectDefaultMetrics({ register: registry });
  const registers = [registry];
  return {
    registry,
    httpDuration: new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request latency by route pattern',
      labelNames: ['method', 'route', 'status'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers,
    }),
    ledgerTransactions: new Counter({ name: 'ledger_transactions_total', help: 'Ledger requests by kind and outcome', labelNames: ['kind', 'outcome'] as const, registers }),
    idempotentReplays: new Counter({ name: 'ledger_idempotent_replays_total', help: 'Requests answered from an earlier result', registers }),
    telemetryAccepted: new Counter({ name: 'telemetry_events_accepted_total', help: 'Events queued on the stream', registers }),
    telemetryDropped: new Counter({ name: 'telemetry_events_dropped_total', help: 'Events dropped by reason', labelNames: ['reason'] as const, registers }),
    workerEntries: new Counter({ name: 'telemetry_worker_entries_total', help: 'Stream entries by result', labelNames: ['result'] as const, registers }),
    streamPending: new Gauge({ name: 'telemetry_stream_pending', help: 'Entries delivered but not acked (XPENDING)', registers }),
    streamLength: new Gauge({ name: 'telemetry_stream_length', help: 'Entries on the telemetry stream (XLEN)', registers }),
  };
}

export function recordWorkerRun(metrics: Metrics, counts: WorkerRunCounts): void {
  metrics.workerEntries.inc({ result: 'applied' }, counts.applied);
  metrics.workerEntries.inc({ result: 'duplicate' }, counts.duplicates);
  metrics.workerEntries.inc({ result: 'malformed' }, counts.malformed);
  metrics.workerEntries.inc({ result: 'dead_letter' }, counts.deadLettered);
}

// Labels use the route pattern, never the raw URL, so player ids cannot blow up cardinality or
// end up in the scrape. Anything that matched no route is "unmatched".
export function registerHttpMetrics(app: ZodApp, metrics: Metrics): void {
  app.addHook('onResponse', async (request, reply) => {
    metrics.httpDuration.observe(
      { method: request.method, route: request.routeOptions.url ?? 'unmatched', status: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
  });
}

// Prometheus scrapes this on its own port, which Compose never publishes, so /metrics is not public.
// host comes from METRICS_HOST, loopback unless set.
export async function startMetricsServer(registry: Registry, port: number, host: string): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/metrics') {
      registry.metrics().then(
        (text) => {
          response.writeHead(200, { 'content-type': registry.contentType });
          response.end(text);
        },
        () => {
          response.writeHead(500);
          response.end();
        },
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}
