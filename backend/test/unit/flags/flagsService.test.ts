import { describe, expect, test } from 'vitest';
import { FLAG_DEFAULTS, FLAGS_COLD_RETRY_MS, createMysqlFlagsService } from '../../../src/modules/flags/flagsService.js';
import type { Db } from '../../../src/platform/db.js';
import { createFakeClock } from '../../support/clock.js';

// A pool stand-in that counts queries. Each query waits on the gate the test opens, then answers
// with the given rows or fails.
function countingDb(): { db: Db; queries: () => number; release(outcome: 'ok' | 'fail'): void; setAutoRelease(outcome: 'ok' | 'fail' | null): void } {
  let count = 0;
  let auto: 'ok' | 'fail' | null = null;
  let waiting: ((outcome: 'ok' | 'fail') => void)[] = [];
  const rows = [{ flag_key: 'ShopEnabled', flag_value: false }];
  const db = {
    query: async () => {
      count += 1;
      const outcome = auto ?? (await new Promise<'ok' | 'fail'>((resolve) => waiting.push(resolve)));
      if (outcome === 'fail') throw new Error('connect ETIMEDOUT');
      return [rows, []];
    },
  } as unknown as Db;
  return {
    db,
    queries: () => count,
    release(outcome) {
      const pending = waiting;
      waiting = [];
      for (const resolve of pending) resolve(outcome);
    },
    setAutoRelease(outcome) {
      auto = outcome;
    },
  };
}

function recordingLogger(): { warn(details: object, message: string): void; lines: string[] } {
  const lines: string[] = [];
  return { lines, warn: (_details, message) => void lines.push(message) };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('mysql flags service reloads', () => {
  test('50 concurrent calls on an expired cache share one query', async () => {
    const clock = createFakeClock();
    const store = countingDb();
    const flags = createMysqlFlagsService(store.db, clock, { logger: recordingLogger() });
    store.setAutoRelease('ok');
    await flags.list();
    store.setAutoRelease(null);
    clock.advance(5_001);

    const calls = Array.from({ length: 50 }, () => flags.list());
    await flush();
    store.release('ok');
    const results = await Promise.all(calls);
    expect(store.queries()).toBe(2);
    for (const result of results) expect(result).toEqual({ ...FLAG_DEFAULTS, ShopEnabled: false });
    // Every caller gets its own copy.
    results[0]!.ShopEnabled = true;
    expect(results[1]!.ShopEnabled).toBe(false);
  });

  test('50 concurrent calls on a failing store with something cached make one query and one warning', async () => {
    const clock = createFakeClock();
    const store = countingDb();
    const logger = recordingLogger();
    const flags = createMysqlFlagsService(store.db, clock, { logger });
    store.setAutoRelease('ok');
    await flags.list();
    store.setAutoRelease(null);
    clock.advance(5_001);

    const calls = Array.from({ length: 50 }, () => flags.list());
    await flush();
    store.release('fail');
    const results = await Promise.all(calls);
    expect(store.queries()).toBe(2);
    expect(logger.lines).toEqual(['flag reload failed; serving the last good values']);
    for (const result of results) expect(result).toMatchObject({ ShopEnabled: false });
  });

  test('a cold failing store is queried once per window and answers 503 in between', async () => {
    const clock = createFakeClock();
    const store = countingDb();
    store.setAutoRelease('fail');
    const flags = createMysqlFlagsService(store.db, clock, { logger: recordingLogger() });

    for (let i = 0; i < 20; i += 1) {
      await expect(flags.list()).rejects.toMatchObject({ statusCode: 503, code: 'flags_unavailable', headers: { 'retry-after': '1' } });
    }
    expect(store.queries()).toBe(1);

    clock.advance(FLAGS_COLD_RETRY_MS - 1);
    await expect(flags.list()).rejects.toMatchObject({ code: 'flags_unavailable' });
    expect(store.queries()).toBe(1);

    clock.advance(1);
    await expect(flags.list()).rejects.toMatchObject({ code: 'flags_unavailable' });
    expect(store.queries()).toBe(2);

    // Once the store answers, the window no longer applies.
    store.setAutoRelease('ok');
    clock.advance(FLAGS_COLD_RETRY_MS);
    await expect(flags.list()).resolves.toMatchObject({ ShopEnabled: false });
    expect(store.queries()).toBe(3);
  });

  test('the cold window is about one second, matching Retry-After', () => {
    expect(FLAGS_COLD_RETRY_MS).toBe(1_000);
  });
});
