import type { Clock } from '../../../platform/clock.js';
import type { Redis } from '../../../platform/redis.js';

export interface WindowCounts {
  current: number;
  previous: number;
}

export interface WindowStore {
  // Adds one hit to `key` in window `windowIndex` and returns that window's count plus the previous one's.
  increment(key: string, windowIndex: number, windowMs: number): Promise<WindowCounts>;
  // The same two counts without adding a hit.
  read(key: string, windowIndex: number): Promise<WindowCounts>;
}

export interface HitResult {
  allowed: boolean;
  estimate: number;
  retryAfterSeconds: number;
}

export interface SlidingWindowOptions {
  limit: number;
  windowMs: number;
  clock: Clock;
  store: WindowStore;
}

// Float maths can leave an estimate a hair over the limit at an exact boundary.
const EPSILON = 1e-9;

// Sliding window counter: two fixed windows blended by how far we are into the current one.
// It avoids the fixed window's double burst at the boundary with O(1) memory per key.
// Every hit is counted, blocked ones too, so hammering a blocked key keeps it blocked.
export class SlidingWindowCounter {
  private readonly options: SlidingWindowOptions;

  constructor(options: SlidingWindowOptions) {
    if (!Number.isInteger(options.limit) || options.limit < 1) throw new RangeError('limit must be a whole number of at least 1');
    if (!Number.isInteger(options.windowMs) || options.windowMs < 1000) throw new RangeError('windowMs must be at least 1000');
    this.options = options;
  }

  async hit(key: string): Promise<HitResult> {
    const { limit, windowMs, clock, store } = this.options;
    const now = clock.now();
    const windowIndex = Math.floor(now / windowMs);
    const elapsed = now - windowIndex * windowMs;
    const { current, previous } = await store.increment(key, windowIndex, windowMs);
    const estimate = previous * ((windowMs - elapsed) / windowMs) + current;
    const allowed = estimate <= limit + EPSILON;
    return { allowed, estimate, retryAfterSeconds: allowed ? 0 : this.secondsUntilFree(current, previous, elapsed) };
  }

  // Would one more hit be allowed? Reads the counts without adding one. This is for limits that only
  // count failures: the caller checks first, before any expensive work, and calls hit() only when
  // the attempt failed.
  async peek(key: string): Promise<HitResult> {
    const { limit, windowMs, clock, store } = this.options;
    const now = clock.now();
    const windowIndex = Math.floor(now / windowMs);
    const elapsed = now - windowIndex * windowMs;
    const { current, previous } = await store.read(key, windowIndex);
    const estimate = previous * ((windowMs - elapsed) / windowMs) + current;
    const allowed = estimate + 1 <= limit + EPSILON;
    return { allowed, estimate, retryAfterSeconds: allowed ? 0 : this.secondsUntilFree(current, previous, elapsed) };
  }

  // How long until one more hit would be allowed, if the caller stops hitting meanwhile. The caller's
  // next hit counts too, so we need room for current + 1. Rounded up to whole seconds and never
  // below 1, so Retry-After can be late by under a second but never early.
  private secondsUntilFree(current: number, previous: number, elapsed: number): number {
    const { limit, windowMs } = this.options;
    let waitMs: number;
    if (current + 1 <= limit) {
      // Still room in this window once the previous window's weight has faded enough.
      const roomForPrevious = limit - current - 1;
      const neededElapsed = previous > 0 ? windowMs - (roomForPrevious * windowMs) / previous : elapsed;
      waitMs = neededElapsed - elapsed;
    } else {
      // This window is full, so wait for the next one, where this window becomes "previous".
      const neededElapsed = windowMs - ((limit - 1) * windowMs) / current;
      waitMs = windowMs - elapsed + neededElapsed;
    }
    return Math.max(1, Math.ceil(waitMs / 1000 - EPSILON));
  }
}

export function createMemoryWindowStore(): WindowStore {
  const counts = new Map<string, number>();
  return {
    async increment(key, windowIndex) {
      const id = `${key}:${windowIndex}`;
      const current = (counts.get(id) ?? 0) + 1;
      counts.set(id, current);
      counts.delete(`${key}:${windowIndex - 2}`);
      return { current, previous: counts.get(`${key}:${windowIndex - 1}`) ?? 0 };
    },
    async read(key, windowIndex) {
      return { current: counts.get(`${key}:${windowIndex}`) ?? 0, previous: counts.get(`${key}:${windowIndex - 1}`) ?? 0 };
    },
  };
}

// Keys look like <prefix>:<key>:<windowIndex>. Each one lives for two windows, then Redis drops it.
// Errors are never swallowed: the caller decides what a broken store means (login fails closed).
export function createRedisWindowStore(redis: Redis, prefix: string): WindowStore {
  return {
    async increment(key, windowIndex, windowMs) {
      const current = `${prefix}:${key}:${windowIndex}`;
      const previous = `${prefix}:${key}:${windowIndex - 1}`;
      const results = await redis.multi().incr(current).pexpire(current, windowMs * 2).get(previous).exec();
      if (!results) throw new Error('the rate limit transaction was aborted');
      for (const [error] of results) if (error) throw error;
      return { current: Number(results[0]?.[1]), previous: Number(results[2]?.[1] ?? 0) };
    },
    async read(key, windowIndex) {
      const [current, previous] = await redis.mget(`${prefix}:${key}:${windowIndex}`, `${prefix}:${key}:${windowIndex - 1}`);
      return { current: Number(current ?? 0), previous: Number(previous ?? 0) };
    },
  };
}
