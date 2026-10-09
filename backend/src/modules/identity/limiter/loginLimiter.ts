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
// Service token exchange. The per-client limit counts only exchanges whose secret verified, so
// nobody without the secret can spend the game server's budget. Failed attempts count against the
// caller's IP only, and an IP over its failure budget is refused before any hash work.
export const SERVICE_TOKEN_LIMIT = { limit: 30, windowMs: 60_000 } as const;
export const SERVICE_TOKEN_IP_FAILURE_LIMIT = { limit: 10, windowMs: 300_000 } as const;

export interface LoginLimiter {
  check(ip: string, email: string): Promise<void>;
}

// Parts are hashed as a JSON array, so no choice of colons, quotes or length in an ip or email can
// make two different pairs share a key, and the Redis key is always the same short size.
function bucketKey(...parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

// Three counters. All of them count attempts (not only failures) and all are checked before the
// password is verified. perIp stops one machine spraying many accounts. perIpAccount is tight: one
// machine gets 5 guesses per 5 minutes at one operator. perAccount is the loose ceiling for an
// attacker who rotates IPs.
//
// They are checked in that order and the first one that blocks throws straight away, so a later
// counter never counts an attempt an earlier counter already refused. That matters: if every
// counter counted every attempt, one attacker IP could keep hammering and burn the shared
// perAccount budget with requests that were blocked anyway, locking the real operator out from
// every IP. With short-circuiting, one IP can add at most 5 to perAccount per 5 minutes.
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
      const steps: [SlidingWindowCounter, string][] = [
        [counters.perIp, bucketKey(ip)],
        [counters.perIpAccount, bucketKey(ip, account)],
        [counters.perAccount, bucketKey(account)],
      ];
      for (const [counter, key] of steps) {
        const result = await counter.hit(key);
        if (!result.allowed) {
          throw new AppError(429, 'rate_limited', 'Too many attempts, try again later', {
            headers: { 'retry-after': String(result.retryAfterSeconds) },
          });
        }
      }
    },
  };
}
