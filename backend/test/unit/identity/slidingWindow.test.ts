import { describe, expect, test } from 'vitest';
import { SlidingWindowCounter, createMemoryWindowStore } from '../../../src/modules/identity/limiter/slidingWindow.js';
import { createFakeClock } from '../../support/clock.js';
import { describeWindowStoreContract } from '../../support/windowStoreContract.js';

describeWindowStoreContract('memory', async () => ({ store: createMemoryWindowStore() }));

const WINDOW_MS = 60_000;

function make(limit = 5) {
  const clock = createFakeClock();
  return { clock, counter: new SlidingWindowCounter({ limit, windowMs: WINDOW_MS, clock, store: createMemoryWindowStore() }) };
}

describe('SlidingWindowCounter', () => {
  test('blocks after the limit within one window', async () => {
    const { counter } = make();
    const results = [];
    for (let i = 0; i < 6; i += 1) results.push((await counter.hit('ip-1')).allowed);
    expect(results).toEqual([true, true, true, true, true, false]);
  });

  test('recovers gradually as the old window slides out', async () => {
    const { counter, clock } = make();
    for (let i = 0; i < 6; i += 1) await counter.hit('ip-1');
    clock.advance(60_000); // next window starts: previous 6 at full weight, so still blocked
    expect((await counter.hit('ip-1')).allowed).toBe(false);
    clock.advance(30_000); // half way: 6 * 0.5 + 2 = 5 is allowed
    await expect(counter.hit('ip-1')).resolves.toMatchObject({ allowed: true, estimate: 5 });
  });

  test('after two quiet windows a key starts fresh', async () => {
    const { counter, clock } = make();
    for (let i = 0; i < 6; i += 1) await counter.hit('ip-1');
    clock.advance(120_000);
    await expect(counter.hit('ip-1')).resolves.toMatchObject({ allowed: true, estimate: 1 });
  });

  test('peek says whether one more hit fits, without counting', async () => {
    const { counter, clock } = make();
    for (let i = 0; i < 4; i += 1) await counter.hit('ip-1');
    await expect(counter.peek('ip-1')).resolves.toMatchObject({ allowed: true, estimate: 4, retryAfterSeconds: 0 });
    await expect(counter.peek('ip-1')).resolves.toMatchObject({ allowed: true, estimate: 4 }); // peeking never counts
    await counter.hit('ip-1');
    const full = await counter.peek('ip-1');
    expect(full).toMatchObject({ allowed: false, estimate: 5 });
    // The stated wait is exact: one second less is still full, the stated seconds frees a slot.
    clock.advance(full.retryAfterSeconds * 1000 - 1000);
    expect((await counter.peek('ip-1')).allowed).toBe(false);
    clock.advance(1000);
    expect((await counter.peek('ip-1')).allowed).toBe(true);
  });

  test('bad settings are refused', () => {
    const clock = createFakeClock();
    const store = createMemoryWindowStore();
    expect(() => new SlidingWindowCounter({ limit: 0, windowMs: 60_000, clock, store })).toThrow(RangeError);
    expect(() => new SlidingWindowCounter({ limit: 1, windowMs: 10, clock, store })).toThrow(RangeError);
  });
});

// S2-F7: Retry-After is the ceil of the time until a retry would be allowed. We prove it from both
// sides: waiting the stated seconds works, and waiting one second less does not.
describe('Retry-After', () => {
  async function blockedAt(offsetMs: number, hits: number) {
    const { counter, clock } = make();
    for (let i = 0; i < hits - 1; i += 1) await counter.hit('k');
    clock.advance(offsetMs);
    const blocked = await counter.hit('k');
    return { counter, clock, blocked };
  }

  test('a hit just over the limit reports the exact ceil to the next window slot', async () => {
    // 6 hits, 15s in. Next window holds previous 6, so 6 * (1 - e) + 1 <= 5 needs e = 20s.
    // Wait is 45s to the boundary plus 20s = 65s.
    const { blocked } = await blockedAt(15_000, 6);
    expect(blocked).toMatchObject({ allowed: false, retryAfterSeconds: 65 });
  });

  test.each([0, 1, 14_999, 15_000, 29_500, 45_001, 59_999])(
    'at %i ms into the window the value is never early and never more than a second late',
    async (offsetMs) => {
      const { counter, clock, blocked } = await blockedAt(offsetMs, 8);
      expect(blocked.allowed).toBe(false);
      const seconds = blocked.retryAfterSeconds;
      expect(seconds).toBeGreaterThanOrEqual(1);

      // One second less is still blocked (this probe is itself counted, so it runs on a copy).
      const early = await blockedAt(offsetMs, 8);
      early.clock.advance((seconds - 1) * 1000);
      expect((await early.counter.hit('k')).allowed).toBe(false);

      // Waiting exactly the stated seconds is enough.
      clock.advance(seconds * 1000);
      expect((await counter.hit('k')).allowed).toBe(true);
    },
  );

  test('while the previous window is still fading in the same window, the wait is the fade time', async () => {
    const { counter, clock } = make();
    for (let i = 0; i < 5; i += 1) await counter.hit('k'); // fills window 0
    clock.advance(60_000); // window 1, previous 5 at full weight
    const first = await counter.hit('k'); // 5 + 1 = 6 > 5, blocked, current is now 1
    expect(first.allowed).toBe(false);
    // Needs previous * (1 - e) + 2 <= 5, so 5 * (1 - e) <= 3, e = 24s.
    expect(first.retryAfterSeconds).toBe(24);
    clock.advance(24_000);
    expect((await counter.hit('k')).allowed).toBe(true);
  });

  test('is never 0 even a millisecond before the slot frees', async () => {
    const { counter, clock } = make(1);
    await counter.hit('k');
    clock.advance(59_999);
    const blocked = await counter.hit('k');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });
});
