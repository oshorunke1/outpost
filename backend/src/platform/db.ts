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

// The smallest logger withTransaction needs. A pino logger fits it as is.
export interface TransactionLogger {
  error(details: object, message: string): void;
}

export interface TransactionOptions {
  attempts?: number; // total tries, including the first (default 3); a safe integer of at least 1
  baseDelayMs?: number; // backoff cap before the second try; it doubles each retry (default 20)
  maxDelayMs?: number; // the backoff cap never grows past this (default 200)
  random?: () => number; // injected for tests, Math.random otherwise
  sleep?: (ms: number) => Promise<void>; // injected for tests, a real timer otherwise
  logger?: TransactionLogger; // told about failed commits and failed rollbacks
}

// The COMMIT itself failed, for example because the connection dropped while it was in flight.
// The server may have applied the transaction or not, and this process cannot tell which. Callers
// must not retry the work blindly; an idempotent caller answers "try again with the same key" and
// lets the replay find out what really happened.
export class CommitOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super('The transaction COMMIT failed, so whether it was applied is unknown', { cause });
    this.name = 'CommitOutcomeUnknownError';
  }
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Full jitter: a uniform wait between 0 and an exponentially growing cap. Transactions that
// collided once spread out instead of waking together and colliding again (S3-F3).
function backoffMs(retry: number, options: TransactionOptions): number {
  const cap = Math.min(options.maxDelayMs ?? 200, (options.baseDelayMs ?? 20) * 2 ** (retry - 1));
  const draw = (options.random ?? Math.random)();
  const unit = Number.isFinite(draw) ? Math.min(1, Math.max(0, draw)) : 0;
  return unit * cap;
}

function errorDetails(error: unknown): object {
  const code = codeOf(error);
  return { err: error instanceof Error ? error.message : String(error), ...(typeof code === 'string' ? { code } : {}) };
}

// Runs work inside one transaction. InnoDB can pick this transaction as a deadlock victim even
// when the code is correct, so a deadlock (1213) or a lock wait timeout (1205) is rolled back and
// the work runs again from the start after a jittered wait, up to attempts tries in all.
//
// Retrying is only safe because every effect of work is inside the rolled-back transaction, so
// work must touch nothing but conn: no Redis, no HTTP, no outside state it mutates. The whole
// transaction is rolled back on a lock wait timeout too, because InnoDB on its own only rolls
// back the timed-out statement.
//
// A failed COMMIT is never retried, since its outcome is unknown; it surfaces as
// CommitOutcomeUnknownError. A connection whose ROLLBACK failed is in an unknown state too, so it
// is destroyed instead of going back to the pool, where the next caller could inherit an open
// transaction and its locks.
export async function withTransaction<T>(db: Db, work: (conn: PoolConnection) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new RangeError(`withTransaction attempts must be a whole number of at least 1, got ${String(attempts)}`);
  }
  for (let attempt = 1; ; attempt += 1) {
    const conn = await db.getConnection();
    let committing = false;
    let reusable = true;
    try {
      await conn.beginTransaction();
      const result = await work(conn);
      committing = true;
      await conn.commit();
      return result;
    } catch (error) {
      try {
        await conn.rollback();
      } catch (rollbackError) {
        reusable = false;
        options.logger?.error(errorDetails(rollbackError), 'transaction rollback failed; destroying the connection');
      }
      if (committing) {
        options.logger?.error(errorDetails(error), 'transaction commit failed; its outcome is unknown');
        throw new CommitOutcomeUnknownError(error);
      }
      if (attempt >= attempts || !RETRYABLE.has(String(codeOf(error)))) throw error;
    } finally {
      if (reusable) conn.release();
      else conn.destroy();
    }
    // Only a retryable failure gets here; success returned and everything else threw. The wait
    // comes after release, so a backing-off transaction never holds a pooled connection.
    await (options.sleep ?? realSleep)(backoffMs(attempt, options));
  }
}

export function isDuplicateKey(error: unknown): boolean {
  return codeOf(error) === 'ER_DUP_ENTRY';
}

export function duplicateKeyName(error: unknown): string | null {
  if (!isDuplicateKey(error) || !(error instanceof Error)) return null;
  return /for key '([^']+)'/.exec(error.message)?.[1] ?? null;
}
