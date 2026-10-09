import type { Db, PoolConnection } from '../../../src/platform/db.js';

type ConnOverrides = (conn: PoolConnection) => Partial<Record<string | symbol, unknown>>;

// A pool whose connections get some methods swapped. Connections are wrapped, never patched, so
// the real pooled connection stays clean for reuse.
function wrapDb(db: Db, overrides: ConnOverrides): Db {
  const wrap = (conn: PoolConnection): PoolConnection => {
    const swapped = overrides(conn);
    return new Proxy(conn, {
      get(target, prop) {
        if (Object.hasOwn(swapped, prop)) return swapped[prop];
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'getConnection') return async () => wrap(await target.getConnection());
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

// Connections fail their COMMIT, either before or after the server applied it.
export function failingCommitDb(db: Db, mode: 'before-apply' | 'after-apply'): Db {
  return wrapDb(db, (conn) => ({
    commit: async () => {
      if (mode === 'after-apply') await conn.commit();
      else await conn.rollback();
      throw Object.assign(new Error('Connection lost: The server closed the connection.'), { code: 'PROTOCOL_CONNECTION_LOST' });
    },
  }));
}

// Every locking read (FOR UPDATE) on a transaction connection times out waiting for its lock, the
// way InnoDB answers after innodb_lock_wait_timeout. attempts counts how often that happened.
export function lockWaitTimeoutDb(db: Db): { db: Db; attempts: () => number } {
  let attempts = 0;
  const failing = wrapDb(db, (conn) => ({
    execute: async (sql: string, values?: unknown) => {
      if (/\bFOR UPDATE\b/.test(sql)) {
        attempts += 1;
        throw Object.assign(new Error('Lock wait timeout exceeded; try restarting transaction'), { code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205 });
      }
      return conn.execute(sql, values as never);
    },
  }));
  return { db: failing, attempts: () => attempts };
}

type Hook = () => Promise<void>;

// Runs hooks[n] just before the (n+1)th query on a transaction connection whose SQL matches, so
// one hook per matching query; a single hook fires once. Used to let another writer commit in the
// gap between a transaction's read and its write.
export function beforeQueryDb(db: Db, match: RegExp, hooks: Hook | readonly Hook[]): Db {
  const queue = typeof hooks === 'function' ? [hooks] : [...hooks];
  return wrapDb(db, (conn) => ({
    query: async (sql: unknown, values?: unknown) => {
      if (typeof sql === 'string' && match.test(sql)) await queue.shift()?.();
      return conn.query(sql as never, values as never);
    },
  }));
}

// Matching queries on a transaction connection are refused the way MySQL refuses a value it cannot
// store (ER_TRUNCATED_WRONG_VALUE, SQLSTATE 22007). Stands in for a row MySQL will never accept.
export function rejectingQueryDb(db: Db, refuse: (sql: string, values: unknown) => boolean): Db {
  return wrapDb(db, (conn) => ({
    query: async (sql: unknown, values?: unknown) => {
      if (typeof sql === 'string' && refuse(sql, values)) {
        throw Object.assign(new Error("Incorrect datetime value for column 'bucket_start'"), { code: 'ER_TRUNCATED_WRONG_VALUE', errno: 1292, sqlState: '22007' });
      }
      return conn.query(sql as never, values as never);
    },
  }));
}

// Records the values of every matching query on a transaction connection, then runs it unchanged.
export function spyQueryDb(db: Db, match: RegExp): { db: Db; calls: unknown[] } {
  const calls: unknown[] = [];
  const spying = wrapDb(db, (conn) => ({
    query: async (sql: unknown, values?: unknown) => {
      if (typeof sql === 'string' && match.test(sql)) calls.push(values);
      return conn.query(sql as never, values as never);
    },
  }));
  return { db: spying, calls };
}
