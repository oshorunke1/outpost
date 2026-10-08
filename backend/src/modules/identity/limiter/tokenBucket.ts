import type { Clock } from '../../../platform/clock.js';

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface TokenBucketOptions {
  capacity: number;
  refillPerSecond: number;
  clock: Clock;
  maxKeys?: number;
}

// A token bucket per key, held in this process. It smooths bursts: a key can spend `capacity`
// requests at once and then gets `refillPerSecond` more. Used for per-client API limits, where a
// per-instance limit is acceptable (ADR 0014). When maxKeys is reached the oldest key is dropped,
// which only ever resets that key to a full bucket.
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly clock: Clock;
  private readonly maxKeys: number;

  constructor(options: TokenBucketOptions) {
    const { capacity, refillPerSecond } = options;
    if (!Number.isFinite(capacity) || capacity < 1) throw new RangeError(`capacity must be at least 1, got ${capacity}`);
    if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
      throw new RangeError(`refillPerSecond must be positive and finite, got ${refillPerSecond}`);
    }
    const maxKeys = options.maxKeys ?? 10_000;
    if (!Number.isInteger(maxKeys) || maxKeys < 1) {
      throw new RangeError(`maxKeys must be a whole number of at least 1, got ${maxKeys}`);
    }
    this.capacity = capacity;
    this.refillPerMs = refillPerSecond / 1000;
    this.clock = options.clock;
    this.maxKeys = maxKeys;
  }

  get size(): number {
    return this.buckets.size;
  }

  allow(key: string): boolean {
    const now = this.clock.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      bucket = { tokens: this.capacity, updatedAt: now };
      this.buckets.set(key, bucket);
    }
    this.refill(bucket, now);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  retryAfterSeconds(key: string): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return 0;
    this.refill(bucket, this.clock.now());
    if (bucket.tokens >= 1) return 0;
    return Math.max(1, Math.ceil((1 - bucket.tokens) / this.refillPerMs / 1000));
  }

  private refill(bucket: Bucket, now: number): void {
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
    bucket.updatedAt = Math.max(bucket.updatedAt, now);
  }

  forget(key: string): void {
    this.buckets.delete(key);
  }
}
