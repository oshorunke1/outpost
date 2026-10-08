import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Db } from '../../../src/platform/db.js';
import { CommitOutcomeUnknownError, createPool, duplicateKeyName, isDuplicateKey, pingDb, withTransaction } from '../../../src/platform/db.js';
import { connectRedis } from '../../../src/platform/redis.js';

function fakePool(): { pool: Db; log: string[] } {
  const log: string[] = [];
  const connection = {
    beginTransaction: async () => void log.push('begin'),
    commit: async () => void log.push('commit'),
    rollback: async () => void log.push('rollback'),
    release: () => void log.push('release'),
    destroy: () => void log.push('destroy'),
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
    const result = await withTransaction(
      pool,
      async () => {
        calls += 1;
        if (calls === 1) throw deadlock();
        return 'ok';
      },
      { sleep: async () => undefined },
    );
    expect(result).toBe('ok');
    expect(log).toEqual(['begin', 'rollback', 'release', 'begin', 'commit', 'release']);
  });

  test('gives up after the last attempt', async () => {
    const { pool } = fakePool();
    await expect(withTransaction(pool, async () => Promise.reject(deadlock()), { attempts: 2, sleep: async () => undefined })).rejects.toThrow('Deadlock');
  });

  test('makes 3 attempts by default and retries a lock wait timeout too', async () => {
    const { pool } = fakePool();
    let calls = 0;
    const lockWait = () => Object.assign(new Error('Lock wait timeout exceeded'), { code: 'ER_LOCK_WAIT_TIMEOUT' });
    const failure = withTransaction(
      pool,
      async () => {
        calls += 1;
        throw calls % 2 === 1 ? lockWait() : deadlock();
      },
      { sleep: async () => undefined },
    );
    await expect(failure).rejects.toThrow('Lock wait timeout');
    expect(calls).toBe(3);
  });

  // Full jitter: each wait is random() times an exponentially growing cap, so transactions that
  // collided once do not wake in lockstep and collide again (S3-F3).
  test('waits a jittered, growing backoff between attempts and never after the last one', async () => {
    const { pool } = fakePool();
    const waits: number[] = [];
    const draws = [0.5, 0.25, 0.9];
    const failure = withTransaction(pool, async () => Promise.reject(deadlock()), {
      attempts: 3,
      baseDelayMs: 20,
      random: () => draws.shift() ?? 0,
      sleep: async (ms) => void waits.push(ms),
    });
    await expect(failure).rejects.toThrow('Deadlock');
    expect(waits).toEqual([10, 10]); // 0.5 * 20, then 0.25 * 40
  });

  test('caps the backoff and keeps it inside 0..cap whatever random returns', async () => {
    const { pool } = fakePool();
    const waits: number[] = [];
    const draws = [0.999, 7, -3, Number.NaN];
    const failure = withTransaction(pool, async () => Promise.reject(deadlock()), {
      attempts: 5,
      baseDelayMs: 20,
      maxDelayMs: 50,
      random: () => draws.shift() ?? 0,
      sleep: async (ms) => void waits.push(ms),
    });
    await expect(failure).rejects.toThrow('Deadlock');
    expect(waits).toHaveLength(4);
    expect(waits[0]).toBeCloseTo(19.98);
    expect(waits.slice(1)).toEqual([40, 0, 0]); // out of range draws are clamped, NaN counts as 0
  });

  test('never retries a failed commit and reports it as CommitOutcomeUnknownError with the cause, logged', async () => {
    const { pool, log } = fakePool();
    const connection = await pool.getConnection();
    const commitFailure = deadlock();
    connection.commit = async () => Promise.reject(commitFailure);
    const logged: { details: object; message: string }[] = [];
    let calls = 0;
    const failure = await withTransaction(
      pool,
      async () => {
        calls += 1;
        return 'ok';
      },
      { sleep: async () => undefined, logger: { error: (details, message) => void logged.push({ details, message }) } },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CommitOutcomeUnknownError);
    expect((failure as CommitOutcomeUnknownError).cause).toBe(commitFailure);
    expect((failure as Error).name).toBe('CommitOutcomeUnknownError');
    expect(calls).toBe(1);
    expect(log).toEqual(['begin', 'rollback', 'release']);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.message).toMatch(/commit/i);
    expect(logged[0]?.details).toMatchObject({ code: 'ER_LOCK_DEADLOCK' });
  });

  test('a failed rollback destroys the connection instead of returning it to the pool', async () => {
    const { pool, log } = fakePool();
    const connection = await pool.getConnection();
    connection.rollback = async () => {
      log.push('rollback');
      throw new Error('connection lost');
    };
    const logged: string[] = [];
    await expect(
      withTransaction(pool, async () => Promise.reject(new Error('boom')), { logger: { error: (_details, message) => void logged.push(message) } }),
    ).rejects.toThrow('boom'); // the original error wins over the rollback error
    expect(log).toEqual(['begin', 'rollback', 'destroy']);
    expect(logged).toHaveLength(1);
  });

  test('a failed rollback on a retryable error still retries, on a fresh connection', async () => {
    const { pool, log } = fakePool();
    const connection = await pool.getConnection();
    let rollbacks = 0;
    connection.rollback = async () => {
      rollbacks += 1;
      log.push('rollback');
      if (rollbacks === 1) throw new Error('connection lost');
    };
    let calls = 0;
    const result = await withTransaction(
      pool,
      async () => {
        calls += 1;
        if (calls === 1) throw deadlock();
        return 'ok';
      },
      { sleep: async () => undefined },
    );
    expect(result).toBe('ok');
    expect(log).toEqual(['begin', 'rollback', 'destroy', 'begin', 'commit', 'release']);
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])('refuses attempts = %s before touching the pool', async (attempts) => {
    const { pool, log } = fakePool();
    await expect(withTransaction(pool, async () => 'ok', { attempts })).rejects.toThrow(RangeError);
    expect(log).toEqual([]);
  });

  test('attempts = 1 means one try and no retry', async () => {
    const { pool } = fakePool();
    let calls = 0;
    const failure = withTransaction(
      pool,
      async () => {
        calls += 1;
        throw deadlock();
      },
      { attempts: 1, sleep: async () => undefined },
    );
    await expect(failure).rejects.toThrow('Deadlock');
    expect(calls).toBe(1);
  });

  test('does not wait before retrying an error it will not retry', async () => {
    const { pool } = fakePool();
    const waits: number[] = [];
    await expect(withTransaction(pool, async () => Promise.reject(new Error('boom')), { sleep: async (ms) => void waits.push(ms) })).rejects.toThrow('boom');
    expect(waits).toEqual([]);
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
// The bound is loose because Windows can take a moment to report a refused connection.
describe('refused services fail fast (S2-F10)', () => {
  const BOUND_MS = 5_000;

  test('MySQL names itself, hides the password, and does not hang', async () => {
    const pool = createPool('mysql://root:s3cretpw@127.0.0.1:1/outpost', { connectionLimit: 1, connectTimeoutMs: 1_500 });
    const started = Date.now();
    try {
      const failure = await pingDb(pool).then(
        () => null,
        (error: unknown) => error as Error,
      );
      expect(failure?.message).toBe('MySQL is unreachable (ECONNREFUSED)');
      expect(failure?.message).not.toContain('s3cretpw');
      expect(Date.now() - started).toBeLessThan(BOUND_MS);
    } finally {
      await pool.end();
    }
  });

  test('Redis names itself, hides the password, and does not hang', async () => {
    const started = Date.now();
    const failure = await connectRedis('redis://:s3cretpw@127.0.0.1:1/15', 1_500).then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toMatch(/^Redis is unreachable [(].*ECONNREFUSED.*[)]$/);
    expect(failure?.message).not.toContain('s3cretpw');
    expect(Date.now() - started).toBeLessThan(BOUND_MS);
  });
});

// A server that accepts the socket and then says nothing is what a hung database looks like, and
// it is the only way to reach the real timeout path.
describe('silent services hit the connect timeout (S2-F10)', () => {
  const TIMEOUT_MS = 400;
  const BOUND_MS = 5_000;
  let server: Server;
  const held: Socket[] = [];
  let port = 0;

  beforeAll(async () => {
    server = createServer((socket) => {
      held.push(socket); // hold it open and never write
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    for (const socket of held) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('MySQL gives up with the timeout reason', async () => {
    const pool = createPool(`mysql://root:s3cretpw@127.0.0.1:${port}/outpost`, { connectionLimit: 1, connectTimeoutMs: TIMEOUT_MS });
    const started = Date.now();
    try {
      const failure = await pingDb(pool).then(
        () => null,
        (error: unknown) => error as Error,
      );
      expect(failure?.message).toBe('MySQL is unreachable (ETIMEDOUT)');
      expect(Date.now() - started).toBeLessThan(BOUND_MS);
    } finally {
      await pool.end();
    }
  });

  test('Redis gives up with the timeout reason', async () => {
    const started = Date.now();
    const failure = await connectRedis(`redis://:s3cretpw@127.0.0.1:${port}/15`, TIMEOUT_MS).then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toMatch(/^Redis is unreachable [(].*(timed out|timeout).*[)]$/i);
    expect(failure?.message).not.toContain('s3cretpw');
    expect(Date.now() - started).toBeLessThan(BOUND_MS);
  });
});
