import { createHash } from 'node:crypto';
import { AppError } from '../../../platform/errors.js';
import { normalizeEmail } from '../repos/operatorRepo.js';
import type { SlidingWindowCounter } from './slidingWindow.js';

export const LOGIN_LIMITS = {
  perIp: { limit: 20, windowMs: 60_000 },
  perIpAccount: { limit: 5, windowMs: 300_000 },
  perAccount: { limit: 20, windowMs: 900_000 },
} as const;
export const REFRESH_LIMIT = { limit: 60, windowMs: 60_000 } as const;
export const SERVICE_TOKEN_LIMIT = { limit: 30, windowMs: 60_000 } as const;

export interface LoginLimiter {
  check(ip: string, email: string): Promise<void>;
}

// Parts are hashed as a JSON array, so no choice of colons, quotes or length in an ip or email can
// make two different pairs share a key, and the Redis key is always the same short size.
function bucketKey(...parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

// Three counters. All of them count attempts (not only failures) and all are checked before the
// password is verified. perIpAccount is tight: one machine gets 5 guesses per 5 minutes at one
// operator. perIp stops one machine spraying many accounts. perAccount is the loose ceiling for an
// attacker who rotates IPs.
//
// This reduces targeted lockout, it does not eliminate it. An attacker with many IPs can still spend
// the perAccount budget and make a real operator wait. What it buys is that the attacker needs a new
// IP for every 5 attempts, and the real operator's own IP has a separate perIpAccount bucket that
// the attacker never touches. The email goes through normalizeEmail, the same helper registration
// and login use, so case and spacing tricks all land in one bucket.
// Store errors are not caught here; AuthService turns them into a 503 so login fails closed.
export function createLoginLimiter(counters: {
  perIp: SlidingWindowCounter;
  perIpAccount: SlidingWindowCounter;
  perAccount: SlidingWindowCounter;
}): LoginLimiter {
  return {
    async check(ip, email) {
      const account = normalizeEmail(email);
      const results = await Promise.all([
        counters.perIp.hit(bucketKey(ip)),
        counters.perIpAccount.hit(bucketKey(ip, account)),
        counters.perAccount.hit(bucketKey(account)),
      ]);
      const blocked = results.filter((result) => !result.allowed);
      if (blocked.length > 0) {
        const retryAfter = Math.max(...blocked.map((result) => result.retryAfterSeconds));
        throw new AppError(429, 'rate_limited', 'Too many attempts, try again later', {
          headers: { 'retry-after': String(retryAfter) },
        });
      }
    },
  };
}
