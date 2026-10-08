import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { LOGIN_LIMITS, createLoginLimiter } from '../../src/modules/identity/limiter/loginLimiter.js';
import { SlidingWindowCounter, createRedisWindowStore } from '../../src/modules/identity/limiter/slidingWindow.js';
import { AppError } from '../../src/platform/errors.js';
import { createFakeClock } from '../support/clock.js';
import { describeWindowStoreContract } from '../support/windowStoreContract.js';
import { createIntegrationContext } from './support/context.js';

describeWindowStoreContract('redis', async () => {
  const ctx = await createIntegrationContext();
  return { store: createRedisWindowStore(ctx.redis, 'ratelimit:test'), teardown: () => ctx.close() };
});

test('redis window keys expire after two windows', async () => {
  const ctx = await createIntegrationContext();
  try {
    const key = randomUUID();
    await createRedisWindowStore(ctx.redis, 'ratelimit:test').increment(key, 7, 60_000);
    const ttl = await ctx.redis.pttl(`ratelimit:test:${key}:7`);
    expect(ttl).toBeGreaterThan(60_000);
    expect(ttl).toBeLessThanOrEqual(120_000);
  } finally {
    await ctx.close();
  }
});

test('the login limiter works end to end on Redis and blocks with rate_limited', async () => {
  const ctx = await createIntegrationContext();
  try {
    const clock = createFakeClock();
    const run = randomUUID();
    const counter = (name: keyof typeof LOGIN_LIMITS) =>
      new SlidingWindowCounter({ ...LOGIN_LIMITS[name], clock, store: createRedisWindowStore(ctx.redis, `ratelimit:test:${run}:${name}`) });
    const limiter = createLoginLimiter({ perIp: counter('perIp'), perIpAccount: counter('perIpAccount'), perAccount: counter('perAccount') });
    const emails = ['A@x.com', ' a@x.com', 'a@X.com', 'A@X.COM ', 'a@x.com'];
    for (const email of emails) await limiter.check('10.0.0.1', email);
    const error = await limiter.check('10.0.0.1', 'a@x.com').then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ statusCode: 429, code: 'rate_limited' });
    expect(Number((error as AppError).headers['retry-after'])).toBeGreaterThanOrEqual(300);
    await expect(limiter.check('10.0.0.2', 'a@x.com')).resolves.toBeUndefined();
  } finally {
    await ctx.close();
  }
});

test('a Redis error is passed up, never treated as allowed', async () => {
  const ctx = await createIntegrationContext();
  const store = createRedisWindowStore(ctx.redis, 'ratelimit:test');
  ctx.redis.disconnect(); // from here every command fails at once, there is no offline queue
  try {
    const counter = new SlidingWindowCounter({ limit: 5, windowMs: 60_000, clock: createFakeClock(), store });
    await expect(counter.hit(randomUUID())).rejects.toThrow();
  } finally {
    await ctx.close().catch(() => undefined);
  }
});
