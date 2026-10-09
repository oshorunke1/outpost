import { z } from 'zod';
import { systemClock } from './clock.js';
import type { Clock } from './clock.js';
import type { ZodApp } from './http.js';

export interface HealthReport {
  ok: boolean;
  draining: boolean;
  checks: Record<string, 'ok' | 'fail'>;
}

export interface HealthChecks {
  ready(): Promise<HealthReport>;
  // From now on readiness answers draining, so the load balancer stops sending new requests.
  // The SIGTERM handler calls it before app.close().
  setDraining(): void;
}

export interface HealthOptions {
  timeoutMs?: number; // a probe slower than this counts as a fail (default 1000)
  cacheMs?: number; // how long one report answers every readiness call (default READY_CACHE_MS)
  clock?: Clock;
}

// A burst of readiness probes (several load balancers, a busy orchestrator) costs one MySQL and
// one Redis round trip per window instead of one per request.
export const READY_CACHE_MS = 1_000;

async function withTimeout<T>(work: () => Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      // Wrapped, so a probe that throws before it returns a promise is still just a fail.
      Promise.resolve().then(work),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createHealthChecks(probes: Record<string, () => Promise<unknown>>, options: HealthOptions = {}): HealthChecks {
  const timeoutMs = options.timeoutMs ?? 1_000;
  const cacheMs = options.cacheMs ?? READY_CACHE_MS;
  const clock = options.clock ?? systemClock;
  let draining = false;
  let cached: { report: HealthReport; at: number } | null = null;
  let inFlight: Promise<HealthReport> | null = null;

  async function probeAll(): Promise<HealthReport> {
    const results = await Promise.all(
      Object.entries(probes).map(async ([name, probe]): Promise<[string, 'ok' | 'fail']> => {
        try {
          await withTimeout(probe, timeoutMs);
          return [name, 'ok'];
        } catch {
          return [name, 'fail'];
        }
      }),
    );
    return { ok: results.every(([, state]) => state === 'ok'), draining: false, checks: Object.fromEntries(results) };
  }

  return {
    async ready() {
      if (draining) return { ok: false, draining: true, checks: {} };
      if (cached && clock.now() - cached.at < cacheMs) return cached.report;
      // Callers that arrive while a probe is running share it.
      inFlight ??= probeAll()
        .then((report) => {
          cached = { report, at: clock.now() };
          return report;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
    setDraining() {
      draining = true;
    },
  };
}

const readyBody = z.object({ status: z.enum(['ready', 'not_ready', 'draining']), checks: z.record(z.string(), z.enum(['ok', 'fail'])) });

// healthz says the process is up (liveness) and never touches a dependency, so a database outage
// never gets the process restarted. readyz says it can serve traffic (readiness).
export function registerHealthRoutes(app: ZodApp, health: HealthChecks): void {
  app.get('/healthz', { schema: { tags: ['ops'], response: { 200: z.object({ status: z.literal('ok') }) } } }, () => ({ status: 'ok' as const }));
  app.get('/readyz', { schema: { tags: ['ops'], response: { 200: readyBody, 503: readyBody } } }, async (_request, reply) => {
    const report = await health.ready();
    const status = report.draining ? 'draining' : report.ok ? 'ready' : 'not_ready';
    return reply.code(report.ok ? 200 : 503).send({ status, checks: report.checks });
  });
}
