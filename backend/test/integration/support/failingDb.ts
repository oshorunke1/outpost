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

// Runs hook once, just before the first query on a transaction connection whose SQL matches. Used
// to let another writer commit in the gap between a transaction's read and its write.
export function beforeQueryDb(db: Db, match: RegExp, hook: () => Promise<void>): Db {
  let fired = false;
  return wrapDb(db, (conn) => ({
    query: async (sql: unknown, values?: unknown) => {
      if (!fired && typeof sql === 'string' && match.test(sql)) {
        fired = true;
        await hook();
      }
      return conn.query(sql as never, values as never);
    },
  }));
}
