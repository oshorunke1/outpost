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
  timeoutMs?: number; // a probe slower than this counts as a fail (default PROBE_TIMEOUT_MS)
  cacheMs?: number; // how long one report answers every readiness call (default READY_CACHE_MS)
  clock?: Clock;
  // Told why a probe failed, at most once per probe per PROBE_LOG_INTERVAL_MS. A pino logger fits.
  logger?: { warn(details: object, message: string): void };
}

// A burst of readiness probes (several load balancers, a busy orchestrator) costs one MySQL and
// one Redis round trip per window instead of one per request.
export const READY_CACHE_MS = 1_000;

// A probe that has not answered by then is a fail, so a blackholed MySQL or Redis is a quick 503
// instead of a request that hangs until the load balancer gives up.
export const PROBE_TIMEOUT_MS = 1_000;

// A dead dependency is probed about once a second; its failure is logged far less often than that.
export const PROBE_LOG_INTERVAL_MS = 30_000;

// Only the error's type, code and message. Never the stack or driver fields such as sql or config.
function failureDetails(name: string, error: unknown): object {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return {
    probe: name,
    type: error instanceof Error ? error.name : typeof error,
    ...(typeof code === 'string' ? { code } : {}),
    reason: error instanceof Error ? error.message : '[non-error]',
  };
}

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
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const cacheMs = options.cacheMs ?? READY_CACHE_MS;
  const clock = options.clock ?? systemClock;
  let draining = false;
  let cached: { report: HealthReport; at: number } | null = null;
  let inFlight: Promise<HealthReport> | null = null;
  const lastLogged = new Map<string, number>();

  function logFailure(name: string, error: unknown): void {
    if (!options.logger) return;
    const last = lastLogged.get(name);
    if (last !== undefined && clock.now() - last < PROBE_LOG_INTERVAL_MS) return;
    lastLogged.set(name, clock.now());
    options.logger.warn(failureDetails(name, error), 'readiness probe failed');
  }

  async function probeAll(): Promise<HealthReport> {
    const results = await Promise.all(
      Object.entries(probes).map(async ([name, probe]): Promise<[string, 'ok' | 'fail']> => {
        try {
          await withTimeout(probe, timeoutMs);
          return [name, 'ok'];
        } catch (error) {
          logFailure(name, error);
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
  const liveness = { tags: ['ops'], operationId: 'getHealth', summary: 'Liveness, the process is up', security: [] };
  const readiness = { tags: ['ops'], operationId: 'getReadiness', summary: 'Readiness, MySQL and Redis both answer', security: [] };
  app.get('/healthz', { schema: { ...liveness, response: { 200: z.object({ status: z.literal('ok') }) } } }, () => ({ status: 'ok' as const }));
  app.get('/readyz', { schema: { ...readiness, response: { 200: readyBody, 503: readyBody } } }, async (_request, reply) => {
    const report = await health.ready();
    const status = report.draining ? 'draining' : report.ok ? 'ready' : 'not_ready';
    return reply.code(report.ok ? 200 : 503).send({ status, checks: report.checks });
  });
}
