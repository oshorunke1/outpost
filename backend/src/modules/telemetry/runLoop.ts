import { setTimeout as delay } from 'node:timers/promises';
import type { Clock } from '../../platform/clock.js';
import { MAX_PRUNE_PASSES } from './worker.js';
import type { TelemetryWorker } from './worker.js';

// How often the stream length and pending gauges are refreshed.
export const SAMPLE_EVERY_MS = 5_000;
// How often processed ids older than a day are pruned. The first prune runs at start.
export const PRUNE_EVERY_MS = 60_000;
// After a failed run the wait doubles from the base up to the max, with jitter (see backoffMs).
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 30_000;

export interface WorkerLoopLogger {
  info(details: object, message: string): void;
  error(details: object, message: string): void;
}

export interface WorkerLoopOptions {
  worker: Pick<TelemetryWorker, 'runOnce' | 'prune' | 'sampleStream'>;
  logger: WorkerLoopLogger;
  clock: Clock;
  // Aborted on SIGTERM or SIGINT. The run in progress finishes (it commits before it acks, so
  // nothing uncommitted is ever acked) and then the loop returns.
  signal: AbortSignal;
  pruneBatchSize: number; // the worker's own value, so the loop knows when a prune call hit its cap
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

// Waits ms, or less if the signal aborts first. Never rejects.
async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch {
    // aborted, so the loop checks the signal and stops
  }
}

// Equal jitter: somewhere between half and all of the cap. The floor of half keeps a dead
// dependency from turning into a busy loop, and the jitter keeps several workers from retrying
// in step.
function backoffMs(failures: number, random: () => number): number {
  const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
  const draw = random();
  const unit = Number.isFinite(draw) ? Math.min(1, Math.max(0, draw)) : 0;
  return cap / 2 + (unit * cap) / 2;
}

function errorFields(error: unknown): { err: string; code?: string } {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return { err: error instanceof Error ? error.message : String(error), ...(typeof code === 'string' ? { code } : {}) };
}

// The worker's main loop. A failed run (Redis or MySQL down) is logged and retried after a capped,
// jittered backoff, so the worker rides out an outage instead of crash looping. Sampling and
// pruning run between runs on their own intervals, and their failures are logged and skipped.
export async function runWorkerLoop(options: WorkerLoopOptions): Promise<void> {
  const { worker, logger, clock, signal } = options;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? abortableSleep;
  const pruneCap = MAX_PRUNE_PASSES * options.pruneBatchSize;
  let failures = 0;
  let lastSample = Number.NEGATIVE_INFINITY;
  let lastPrune = Number.NEGATIVE_INFINITY;

  // One prune call removes at most pruneCap rows. A call that hit the cap means more are left,
  // so it goes again until a call comes back short (or the worker is stopping).
  async function pruneAll(): Promise<void> {
    let total = 0;
    for (;;) {
      const removed = await worker.prune();
      total += removed;
      if (removed < pruneCap || signal.aborted) break;
    }
    if (total > 0) logger.info({ pruned: total }, 'pruned processed telemetry ids');
  }

  while (!signal.aborted) {
    if (clock.now() - lastPrune >= PRUNE_EVERY_MS) {
      lastPrune = clock.now();
      await pruneAll().catch((error: unknown) => logger.error(errorFields(error), 'pruning processed telemetry ids failed'));
    }
    if (clock.now() - lastSample >= SAMPLE_EVERY_MS) {
      lastSample = clock.now();
      await worker.sampleStream().catch((error: unknown) => logger.error(errorFields(error), 'sampling the telemetry stream failed'));
    }
    if (signal.aborted) break;
    try {
      await worker.runOnce();
      failures = 0;
    } catch (error) {
      failures += 1;
      const delayMs = backoffMs(failures, random);
      logger.error({ failures, delayMs, ...errorFields(error) }, 'telemetry worker run failed, backing off');
      if (!signal.aborted) await sleep(delayMs, signal);
    }
  }
}
