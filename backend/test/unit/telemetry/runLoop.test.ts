import { describe, expect, test } from 'vitest';
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS, PRUNE_EVERY_MS, SAMPLE_EVERY_MS, runWorkerLoop } from '../../../src/modules/telemetry/runLoop.js';
import { MAX_PRUNE_PASSES } from '../../../src/modules/telemetry/worker.js';
import type { ProcessResult } from '../../../src/modules/telemetry/worker.js';
import { createFakeClock } from '../../support/clock.js';

const ok: ProcessResult = { applied: 1, duplicates: 0, malformed: 0, deadLettered: 0 };

interface HarnessOptions {
  runOnce: (call: number) => Promise<ProcessResult>;
  prune?: (call: number, abort: () => void) => Promise<number>;
  sample?: (abort: () => void) => void;
  stopAfterRuns: number;
  random?: () => number;
}

function harness(options: HarnessOptions) {
  const clock = createFakeClock();
  const controller = new AbortController();
  const events: string[] = [];
  const sleeps: number[] = [];
  const errors: { details: Record<string, unknown>; message: string }[] = [];
  let runs = 0;
  let prunes = 0;
  const worker = {
    async runOnce() {
      runs += 1;
      events.push(`run${runs}`);
      clock.advance(1_000); // each run takes a second, like a short XREADGROUP block
      try {
        return await options.runOnce(runs);
      } finally {
        if (runs >= options.stopAfterRuns) controller.abort();
      }
    },
    async prune() {
      prunes += 1;
      events.push(`prune${prunes}`);
      return options.prune ? options.prune(prunes, () => controller.abort()) : 0;
    },
    async sampleStream() {
      events.push('sample');
      options.sample?.(() => controller.abort());
      return { length: 0, pending: 0 };
    },
  };
  const logger = {
    info: () => undefined,
    error: (details: object, message: string) => void errors.push({ details: details as Record<string, unknown>, message }),
  };
  const done = runWorkerLoop({
    worker,
    logger,
    clock,
    signal: controller.signal,
    pruneBatchSize: 10,
    random: options.random ?? (() => 1),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.advance(ms);
    },
  });
  return { done, events, sleeps, errors, runs: () => runs };
}

describe('runWorkerLoop', () => {
  test('a rejected runOnce is logged and backed off, and the loop keeps running', async () => {
    const failure = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const h = harness({ runOnce: async (call) => (call <= 3 ? Promise.reject(failure) : ok), stopAfterRuns: 5 });
    await h.done;
    expect(h.runs()).toBe(5);
    expect(h.errors).toHaveLength(3);
    expect(h.errors[0]).toEqual({
      details: { failures: 1, delayMs: BACKOFF_BASE_MS, err: 'read ECONNRESET', code: 'ECONNRESET' },
      message: 'telemetry worker run failed, backing off',
    });
    // random() is 1 here, so each wait is the full cap, which doubles from the base.
    expect(h.sleeps).toEqual([BACKOFF_BASE_MS, BACKOFF_BASE_MS * 2, BACKOFF_BASE_MS * 4]);
  });

  test('the backoff is jittered between half and all of the cap, and the cap stops growing', async () => {
    const low = harness({ runOnce: async () => Promise.reject(new Error('down')), stopAfterRuns: 12, random: () => 0 });
    await low.done;
    // With random() at 0 the wait is half the cap, so a dead dependency never turns into a busy loop.
    expect(low.sleeps[0]).toBe(BACKOFF_BASE_MS / 2);
    expect(Math.max(...low.sleeps)).toBe(BACKOFF_MAX_MS / 2);
    const high = harness({ runOnce: async () => Promise.reject(new Error('down')), stopAfterRuns: 12 });
    await high.done;
    expect(Math.max(...high.sleeps)).toBe(BACKOFF_MAX_MS);
  });

  test('a success resets the backoff', async () => {
    const h = harness({ runOnce: async (call) => ([1, 2, 4].includes(call) ? Promise.reject(new Error('blip')) : ok), stopAfterRuns: 5 });
    await h.done;
    expect(h.sleeps).toEqual([BACKOFF_BASE_MS, BACKOFF_BASE_MS * 2, BACKOFF_BASE_MS]);
  });

  test('the stream is sampled on its interval, and prune runs first and then on its interval', async () => {
    const runs = PRUNE_EVERY_MS / 1_000 + 2;
    const h = harness({ runOnce: async () => ok, stopAfterRuns: runs });
    await h.done;
    const samples = h.events.filter((event) => event === 'sample').length;
    expect(samples).toBeGreaterThanOrEqual(Math.floor((runs * 1_000) / SAMPLE_EVERY_MS));
    expect(samples).toBeLessThanOrEqual(Math.ceil((runs * 1_000) / SAMPLE_EVERY_MS) + 1);
    expect(h.events.filter((event) => event.startsWith('prune'))).toEqual(['prune1', 'prune2']);
    expect(h.events.indexOf('prune1')).toBeLessThan(h.events.indexOf('run1'));
  });

  test('prune is called again while a call removes a full cap of rows', async () => {
    const cap = MAX_PRUNE_PASSES * 10;
    const h = harness({ runOnce: async () => ok, prune: async (call) => (call <= 2 ? cap : 3), stopAfterRuns: 1 });
    await h.done;
    expect(h.events.filter((event) => event.startsWith('prune'))).toEqual(['prune1', 'prune2', 'prune3']);
  });

  test('a failing prune is logged and never stops the loop', async () => {
    const h = harness({ runOnce: async () => ok, prune: async () => Promise.reject(new Error('lock wait')), stopAfterRuns: 3 });
    await h.done;
    expect(h.runs()).toBe(3);
    expect(h.errors.map((line) => line.message)).toContain('pruning processed telemetry ids failed');
  });

  test('an abort lets the current run finish and then stops, with no further run', async () => {
    let finished = false;
    const h = harness({
      runOnce: async () => {
        await Promise.resolve();
        finished = true;
        return ok;
      },
      stopAfterRuns: 1,
    });
    await h.done;
    expect(finished).toBe(true);
    expect(h.runs()).toBe(1);
  });

  // M4: SIGTERM can land while the loop prunes or samples. No new batch may start after that,
  // since one more XREADGROUP block would eat into the shutdown deadline.
  test('an abort during sampling stops the loop before another run', async () => {
    const h = harness({ runOnce: async () => ok, stopAfterRuns: 100, sample: (abort) => abort() });
    await h.done;
    expect(h.runs()).toBe(0);
    expect(h.events).toEqual(['prune1', 'sample']);
  });

  test('an abort during a prune that hit the cap stops pruning and starts no run', async () => {
    const cap = MAX_PRUNE_PASSES * 10;
    const h = harness({
      runOnce: async () => ok,
      stopAfterRuns: 100,
      prune: async (call, abort) => {
        abort();
        return call === 1 ? cap : 3; // more rows are left after the first call, but the worker is stopping
      },
    });
    await h.done;
    expect(h.events.filter((event) => event.startsWith('prune'))).toEqual(['prune1']);
    expect(h.runs()).toBe(0);
  });
});
