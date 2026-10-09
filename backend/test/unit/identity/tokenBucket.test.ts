import { describe, expect, test } from 'vitest';
import { TokenBucketLimiter } from '../../../src/modules/identity/limiter/tokenBucket.js';
import { createFakeClock } from '../../support/clock.js';

describe('TokenBucketLimiter', () => {
  test('allows a burst up to capacity, then refuses', () => {
    const limiter = new TokenBucketLimiter({ capacity: 3, refillPerSecond: 1, clock: createFakeClock() });
    expect([1, 2, 3, 4].map(() => limiter.allow('game-server'))).toEqual([true, true, true, false]);
  });

  test('refills over time and never above capacity', () => {
    const clock = createFakeClock();
    const limiter = new TokenBucketLimiter({ capacity: 2, refillPerSecond: 2, clock });
    limiter.allow('k');
    limiter.allow('k');
    expect(limiter.allow('k')).toBe(false);
    expect(limiter.retryAfterSeconds('k')).toBe(1);
    clock.advance(500);
    expect(limiter.allow('k')).toBe(true);
    clock.advance(60_000);
    expect([1, 2, 3].map(() => limiter.allow('k'))).toEqual([true, true, false]);
  });

  test('a clock that jumps backwards adds no tokens and never throws', () => {
    const clock = createFakeClock();
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1, clock });
    expect(limiter.allow('k')).toBe(true);
    clock.advance(-10_000);
    expect(limiter.allow('k')).toBe(false);
  });

  test('keys are independent and maxKeys bounds memory', () => {
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1, clock: createFakeClock(), maxKeys: 2 });
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('b')).toBe(true);
    expect(limiter.allow('c')).toBe(true);
    expect(limiter.size).toBe(2);
    limiter.forget('c');
    expect(limiter.size).toBe(1);
  });

  test('a flood of distinct keys never grows past maxKeys and evicts the oldest first', () => {
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1, clock: createFakeClock(), maxKeys: 3 });
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('a')).toBe(false); // a is spent
    for (let i = 0; i < 1_000; i += 1) limiter.allow(`flood-${i}`);
    expect(limiter.size).toBe(3);
    expect(limiter.allow('a')).toBe(true); // a was evicted, so it starts with a full bucket again
    expect(limiter.size).toBe(3);
  });

  test('retryAfterSeconds refills first, so idle time is counted', () => {
    const clock = createFakeClock();
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 0.1, clock });
    limiter.allow('k');
    expect(limiter.allow('k')).toBe(false);
    expect(limiter.retryAfterSeconds('k')).toBe(10);
    clock.advance(4_000);
    expect(limiter.retryAfterSeconds('k')).toBe(6);
    clock.advance(6_000);
    expect(limiter.retryAfterSeconds('k')).toBe(0);
    expect(limiter.allow('k')).toBe(true);
  });

  test('bad settings are refused', () => {
    const clock = createFakeClock();
    expect(() => new TokenBucketLimiter({ capacity: 0, refillPerSecond: 1, clock })).toThrow(RangeError);
    expect(() => new TokenBucketLimiter({ capacity: 1, refillPerSecond: Number.NaN, clock })).toThrow(RangeError);
    expect(() => new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1, clock, maxKeys: 0 })).toThrow(RangeError);
  });
});
