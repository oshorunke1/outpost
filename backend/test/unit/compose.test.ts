import { describe, expect, test } from 'vitest';
import { createAppDeps, loadSigningKey } from '../../src/compose.js';
import { MEMORY_CONFIG } from '../../src/memoryDeps.js';
import { exportPrivateKeyPem, generateKeyPair } from '../../src/modules/identity/crypto/keys.js';
import { FAST_ARGON2 } from '../../src/modules/identity/crypto/password.js';
import type { Db } from '../../src/platform/db.js';
import { PROBE_LOG_INTERVAL_MS, READY_CACHE_MS } from '../../src/platform/health.js';
import { createMetrics } from '../../src/platform/metrics.js';
import type { Redis } from '../../src/platform/redis.js';
import { createFakeClock } from '../support/clock.js';
import type { FakeClock } from '../support/clock.js';

describe('loadSigningKey', () => {
  test('uses the configured key, so the kid is the same on every boot', async () => {
    const original = await generateKeyPair();
    const pem = await exportPrivateKeyPem(original); // made at runtime, never committed
    const loaded = await loadSigningKey({ ...MEMORY_CONFIG, nodeEnv: 'production', jwtPrivateKeyPem: pem });
    expect(loaded.kid).toBe(original.kid);
  });

  test('production refuses to make up a key', async () => {
    await expect(loadSigningKey({ ...MEMORY_CONFIG, nodeEnv: 'production', jwtPrivateKeyPem: null })).rejects.toThrow(
      'JWT_PRIVATE_KEY_PEM is required in production',
    );
  });

  test('development generates a fresh key at startup', async () => {
    const first = await loadSigningKey({ ...MEMORY_CONFIG, nodeEnv: 'development' });
    const second = await loadSigningKey({ ...MEMORY_CONFIG, nodeEnv: 'development' });
    expect(first.kid).not.toBe(second.kid);
  });
});

// Task 19 carry: compose hands its one logger to the readiness checks, and each failing probe is
// rate limited on its own key, so a MySQL outage never hides a Redis one.
describe('createAppDeps readiness logging', () => {
  const down = (code: string) => Object.assign(new Error(`connect ${code}`), { code });
  const infraWithDeadProbes = (clock: FakeClock) => ({
    db: { query: () => Promise.reject(down('ECONNREFUSED')) } as unknown as Db,
    redis: { ping: () => Promise.reject(down('ETIMEDOUT')) } as unknown as Redis,
    clock,
    metrics: createMetrics(),
  });

  test('two failing probes each log once per window through the compose logger', async () => {
    const clock = createFakeClock();
    const warnings: { details: Record<string, unknown>; message: string }[] = [];
    const logger = {
      warn: (details: object, message: string) => void warnings.push({ details: details as Record<string, unknown>, message }),
      error: () => undefined,
    };
    const deps = await createAppDeps(MEMORY_CONFIG, infraWithDeadProbes(clock), { argon2: FAST_ARGON2, logger });

    expect(await deps.health.ready()).toEqual({ ok: false, draining: false, checks: { mysql: 'fail', redis: 'fail' } });
    expect(warnings.map((line) => [line.details.probe, line.details.code, line.message]).sort()).toEqual([
      ['mysql', 'ECONNREFUSED', 'readiness probe failed'],
      ['redis', 'ETIMEDOUT', 'readiness probe failed'],
    ]);

    clock.advance(READY_CACHE_MS);
    await deps.health.ready();
    expect(warnings).toHaveLength(2);

    clock.advance(PROBE_LOG_INTERVAL_MS);
    await deps.health.ready();
    expect(warnings.map((line) => line.details.probe).sort()).toEqual(['mysql', 'mysql', 'redis', 'redis']);
  });
});
