import { describe, expect, test } from 'vitest';
import type { Db } from '../../../src/platform/db.js';
import { createPool, duplicateKeyName, isDuplicateKey, pingDb, withTransaction } from '../../../src/platform/db.js';
import { connectRedis } from '../../../src/platform/redis.js';

function fakePool(): { pool: Db; log: string[] } {
  const log: string[] = [];
  const connection = {
    beginTransaction: async () => void log.push('begin'),
    commit: async () => void log.push('commit'),
    rollback: async () => void log.push('rollback'),
    release: () => void log.push('release'),
  };
  return { pool: { getConnection: async () => connection } as unknown as Db, log };
}

const deadlock = () => Object.assign(new Error('Deadlock found'), { code: 'ER_LOCK_DEADLOCK' });

describe('withTransaction', () => {
  test('commits and releases on success', async () => {
    const { pool, log } = fakePool();
    await expect(withTransaction(pool, async () => 'done')).resolves.toBe('done');
    expect(log).toEqual(['begin', 'commit', 'release']);
  });

  test('retries a deadlock, then succeeds', async () => {
    const { pool, log } = fakePool();
    let calls = 0;
    const result = await withTransaction(pool, async () => {
      calls += 1;
      if (calls === 1) throw deadlock();
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(log).toEqual(['begin', 'rollback', 'release', 'begin', 'commit', 'release']);
  });

  test('gives up after the last attempt', async () => {
    const { pool } = fakePool();
    await expect(withTransaction(pool, async () => Promise.reject(deadlock()), 2)).rejects.toThrow('Deadlock');
  });

  test('never retries other errors', async () => {
    const { pool, log } = fakePool();
    await expect(withTransaction(pool, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(log).toEqual(['begin', 'rollback', 'release']);
  });
});

describe('duplicate keys', () => {
  test('are recognised with the key name', () => {
    const error = Object.assign(new Error("Duplicate entry 'x' for key 'ledger_transactions.uq_ledger_refund_of'"), {
      code: 'ER_DUP_ENTRY',
    });
    expect(isDuplicateKey(error)).toBe(true);
    expect(duplicateKeyName(error)).toBe('ledger_transactions.uq_ledger_refund_of');
    expect(isDuplicateKey(new Error('other'))).toBe(false);
    expect(duplicateKeyName('not an error')).toBeNull();
  });
});

// Port 1 on loopback refuses at once, so these prove the failure is quick and names the service.
describe('unreachable services fail fast (S2-F10)', () => {
  const TIMEOUT_MS = 1_500;

  test('MySQL names itself, hides the password, and does not hang', async () => {
    const pool = createPool('mysql://root:s3cretpw@127.0.0.1:1/outpost', { connectionLimit: 1, connectTimeoutMs: TIMEOUT_MS });
    const started = Date.now();
    try {
      const failure = await pingDb(pool).then(
        () => null,
        (error: unknown) => error as Error,
      );
      expect(failure?.message).toMatch(/^MySQL is unreachable \(ECONNREFUSED\)$/);
      expect(failure?.message).not.toContain('s3cretpw');
      expect(Date.now() - started).toBeLessThan(TIMEOUT_MS);
    } finally {
      await pool.end();
    }
  });

  test('Redis names itself, hides the password, and does not hang', async () => {
    const started = Date.now();
    const failure = await connectRedis('redis://:s3cretpw@127.0.0.1:1/15', TIMEOUT_MS).then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toMatch(/^Redis is unreachable \(.*ECONNREFUSED.*\)$/);
    expect(failure?.message).not.toContain('s3cretpw');
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS);
  });
});
