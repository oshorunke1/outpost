import { describe, expect, test } from 'vitest';
import { LOGIN_LIMITS, createLoginLimiter } from '../../../src/modules/identity/limiter/loginLimiter.js';
import { SlidingWindowCounter, createMemoryWindowStore } from '../../../src/modules/identity/limiter/slidingWindow.js';
import type { WindowStore } from '../../../src/modules/identity/limiter/slidingWindow.js';
import { AppError } from '../../../src/platform/errors.js';
import { createFakeClock } from '../../support/clock.js';

function make(store: () => WindowStore = createMemoryWindowStore) {
  const clock = createFakeClock();
  const counter = (limits: { limit: number; windowMs: number }) => new SlidingWindowCounter({ ...limits, clock, store: store() });
  const limiter = createLoginLimiter({
    perIp: counter(LOGIN_LIMITS.perIp),
    perIpAccount: counter(LOGIN_LIMITS.perIpAccount),
    perAccount: counter(LOGIN_LIMITS.perAccount),
  });
  return { clock, limiter };
}

async function caught(promise: Promise<void>): Promise<AppError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

function expectRateLimited(error: AppError): void {
  expect(error).toMatchObject({ statusCode: 429, code: 'rate_limited' });
  expect(Number(error.headers['retry-after'])).toBeGreaterThan(0);
}

describe('login limiter', () => {
  test('the published limits are the ruled ones', () => {
    expect(LOGIN_LIMITS).toEqual({
      perIp: { limit: 20, windowMs: 60_000 },
      perIpAccount: { limit: 5, windowMs: 300_000 },
      perAccount: { limit: 20, windowMs: 900_000 },
    });
  });

  test('(a) one IP is blocked after 5 attempts at one email while another IP is still allowed', async () => {
    const { limiter } = make();
    for (let i = 0; i < 5; i += 1) await limiter.check('10.0.0.1', 'a@x.com');
    const error = await caught(limiter.check('10.0.0.1', 'a@x.com'));
    expectRateLimited(error);
    // The 6th attempt lands in a 5 minute window, so the wait is at least the rest of it.
    const seconds = Number(error.headers['retry-after']);
    expect(seconds).toBeGreaterThanOrEqual(300);
    expect(seconds).toBeLessThanOrEqual(600);
    // The real operator on another IP is untouched by the attacker's bucket.
    await expect(limiter.check('10.0.0.2', 'a@x.com')).resolves.toBeUndefined();
  });

  test('(b) an attacker on many IPs eventually hits the per account limit at 20', async () => {
    const { limiter } = make();
    for (let i = 0; i < 20; i += 1) await limiter.check(`10.1.0.${i}`, 'victim@x.com');
    const error = await caught(limiter.check('10.1.0.200', 'victim@x.com'));
    expectRateLimited(error);
    // Fresh IP, so only perAccount can be the reason, and its window is 15 minutes.
    expect(Number(error.headers['retry-after'])).toBeGreaterThan(600);
    // A different account from the same fresh IP is fine.
    await expect(limiter.check('10.1.0.200', 'other@x.com')).resolves.toBeUndefined();
  });

  test('blocked attempts from one IP never burn the account budget for other IPs', async () => {
    const { limiter } = make();
    for (let i = 0; i < 5; i += 1) await limiter.check('10.0.0.1', 'victim@x.com');
    for (let i = 0; i < 30; i += 1) expectRateLimited(await caught(limiter.check('10.0.0.1', 'victim@x.com')));
    // perAccount saw only the 5 real attempts, so 15 more fresh IPs still fit under its limit of 20.
    await expect(limiter.check('10.0.0.2', 'victim@x.com')).resolves.toBeUndefined();
    for (let i = 3; i < 17; i += 1) await limiter.check(`10.0.0.${i}`, 'victim@x.com');
    expectRateLimited(await caught(limiter.check('10.0.0.50', 'victim@x.com')));
  });

  test('one IP spraying many accounts is stopped by the IP limit', async () => {
    const { limiter } = make();
    for (let i = 0; i < 20; i += 1) await limiter.check('10.0.0.1', `account-${i}@x.com`);
    const error = await caught(limiter.check('10.0.0.1', 'account-new@x.com'));
    expectRateLimited(error);
    expect(Number(error.headers['retry-after'])).toBeLessThanOrEqual(120);
  });

  test('S2-F1 case and whitespace variants of an email share ONE per IP and account bucket', async () => {
    const { limiter } = make();
    const variants = ['A@x.com', ' a@x.com', 'a@X.COM ', '\tA@x.com\n', 'a@x.com'];
    for (const email of variants) await limiter.check('10.0.0.1', email);
    expectRateLimited(await caught(limiter.check('10.0.0.1', 'a@x.com')));
  });

  test('S2-F1 composed and decomposed accents share one bucket too', async () => {
    const { limiter } = make();
    const composed = 'josé@x.com';
    const decomposed = 'josé@x.com';
    for (const email of [composed, decomposed, composed.toUpperCase(), decomposed, composed]) {
      await limiter.check('10.0.0.1', email);
    }
    expectRateLimited(await caught(limiter.check('10.0.0.1', decomposed)));
  });

  test('keys with colons never collide', async () => {
    const { limiter } = make();
    // A naive "ip:email" key makes these two pairs identical.
    for (let i = 0; i < 5; i += 1) await limiter.check('a', 'b:c@x.com');
    await expect(limiter.check('a:b', 'c@x.com')).resolves.toBeUndefined();
    // And a colon in the ip does not merge it with a different ip.
    for (let i = 0; i < 5; i += 1) await limiter.check('2001:db8::1', 'z@x.com');
    await expect(limiter.check('2001:db8::2', 'z@x.com')).resolves.toBeUndefined();
  });

  test('very long and odd inputs work and keep separate buckets', async () => {
    const seen: string[] = [];
    const spy = (): WindowStore => {
      const inner = createMemoryWindowStore();
      return {
        increment: async (key, windowIndex, windowMs) => {
          seen.push(key);
          return inner.increment(key, windowIndex, windowMs);
        },
        read: (key, windowIndex) => inner.read(key, windowIndex),
      };
    };
    const { limiter } = make(spy);
    const longEmail = `${'x'.repeat(100_000)}@x.com`;
    for (let i = 0; i < 5; i += 1) await limiter.check('10.0.0.1', longEmail);
    expectRateLimited(await caught(limiter.check('10.0.0.1', longEmail)));
    await expect(limiter.check('10.0.0.1', `${'x'.repeat(100_000)}y@x.com`)).resolves.toBeUndefined();
    await limiter.check('weird \u0000 "ip" \n', 'q@x.com');
    // Every key handed to the store is a fixed size hex digest, whatever went in.
    expect(seen.length).toBeGreaterThan(0);
    for (const key of seen) expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a store failure is passed up unchanged, so the caller fails closed', async () => {
    const broken: WindowStore = {
      increment: async () => Promise.reject(new Error('redis down')),
      read: async () => Promise.reject(new Error('redis down')),
    };
    const { limiter } = make(() => broken);
    const error = await limiter.check('10.0.0.1', 'a@x.com').then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AppError);
    expect((error as Error).message).toBe('redis down');
  });

  test('one failing counter fails the whole check even if the others say yes', async () => {
    const ok = createMemoryWindowStore();
    let calls = 0;
    const flaky: WindowStore = {
      increment: async (key, windowIndex, windowMs) => {
        calls += 1;
        if (calls === 2) throw new Error('redis blip');
        return ok.increment(key, windowIndex, windowMs);
      },
      read: (key, windowIndex) => ok.read(key, windowIndex),
    };
    const { limiter } = make(() => flaky);
    await expect(limiter.check('10.0.0.1', 'a@x.com')).rejects.toThrow('redis blip');
  });
});
