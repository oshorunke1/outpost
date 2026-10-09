import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { WindowStore } from '../../src/modules/identity/limiter/slidingWindow.js';

export function describeWindowStoreContract(
  label: string,
  setup: () => Promise<{ store: WindowStore; teardown?: () => Promise<void> }>,
): void {
  describe(`WindowStore contract (${label})`, () => {
    let store: WindowStore;
    let teardown: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      ({ store, teardown } = await setup());
    });
    afterAll(async () => {
      await teardown?.();
    });

    test('counts hits in the current window and reports the previous one', async () => {
      const key = randomUUID();
      await store.increment(key, 10, 60_000);
      await store.increment(key, 10, 60_000);
      await expect(store.increment(key, 11, 60_000)).resolves.toEqual({ current: 1, previous: 2 });
    });

    test('read reports both counts without adding a hit', async () => {
      const key = randomUUID();
      await expect(store.read(key, 20)).resolves.toEqual({ current: 0, previous: 0 });
      await store.increment(key, 20, 60_000);
      await store.increment(key, 21, 60_000);
      await expect(store.read(key, 21)).resolves.toEqual({ current: 1, previous: 1 });
      await expect(store.read(key, 21)).resolves.toEqual({ current: 1, previous: 1 });
      await expect(store.increment(key, 21, 60_000)).resolves.toEqual({ current: 2, previous: 1 });
    });

    test('keys never share counts', async () => {
      const a = randomUUID();
      const b = randomUUID();
      await store.increment(a, 1, 60_000);
      await expect(store.increment(b, 1, 60_000)).resolves.toEqual({ current: 1, previous: 0 });
    });

    test('keys with colons and very long keys stay separate', async () => {
      const base = randomUUID();
      const long = `${base}:${'x'.repeat(5_000)}`;
      await store.increment(`${base}:1`, 5, 60_000);
      await store.increment(`${base}:1`, 5, 60_000);
      await expect(store.increment(base, 5, 60_000)).resolves.toEqual({ current: 1, previous: 0 });
      await expect(store.increment(long, 5, 60_000)).resolves.toEqual({ current: 1, previous: 0 });
      await expect(store.increment(long, 5, 60_000)).resolves.toEqual({ current: 2, previous: 0 });
    });
  });
}
