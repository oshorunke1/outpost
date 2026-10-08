import { createPool as createMysqlPool } from 'mysql2/promise';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export type Db = Pool;
export type { PoolConnection, ResultSetHeader, RowDataPacket };

export interface PoolOptions {
  multipleStatements?: boolean; // only the migration runner turns this on
  connectionLimit?: number;
  connectTimeoutMs?: number; // how long a new connection may take before it fails
}

export function createPool(url: string, options: PoolOptions = {}): Db {
  return createMysqlPool({
    uri: url,
    connectionLimit: options.connectionLimit ?? 10,
    connectTimeout: options.connectTimeoutMs ?? 5_000,
    multipleStatements: options.multipleStatements ?? false,
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: false,
    decimalNumbers: true,
    enableKeepAlive: true,
  });
}

// A pool connects lazily, so a dead database would only show up on the first query. Calling this
// at startup makes it fail at once with an error that names the service and never prints the URL.
export async function pingDb(db: Db): Promise<void> {
  try {
    await db.query('SELECT 1');
  } catch (error) {
    const code = codeOf(error);
    const reason = typeof code === 'string' ? code : error instanceof Error ? error.message : 'unknown error';
    throw new Error(`MySQL is unreachable (${reason})`, { cause: error });
  }
}

const RETRYABLE = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);

function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
}

// Runs work inside one transaction. InnoDB can pick this transaction as a deadlock victim even
// when the code is correct, so those (and lock wait timeouts) are retried from the start.
export async function withTransaction<T>(db: Db, work: (conn: PoolConnection) => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const result = await work(conn);
      await conn.commit();
      return result;
    } catch (error) {
      await conn.rollback().catch(() => undefined);
      if (attempt >= attempts || !RETRYABLE.has(String(codeOf(error)))) throw error;
    } finally {
      conn.release();
    }
  }
}

export function isDuplicateKey(error: unknown): boolean {
  return codeOf(error) === 'ER_DUP_ENTRY';
}

export function duplicateKeyName(error: unknown): string | null {
  if (!isDuplicateKey(error) || !(error instanceof Error)) return null;
  return /for key '([^']+)'/.exec(error.message)?.[1] ?? null;
}
