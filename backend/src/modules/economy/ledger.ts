import { randomUUID } from 'node:crypto';
import type { Clock } from '../../platform/clock.js';
import { CommitOutcomeUnknownError, duplicateKeyName, isDuplicateKey, withTransaction } from '../../platform/db.js';
import type { Db, PoolConnection, RowDataPacket, TransactionLogger } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import { isPlayerAccount, playerAccountId } from './accounts.js';
import { isItemId } from './catalog.js';
import type { ItemId } from './catalog.js';
import { planRefund, planTransaction, requestHash } from './plan.js';
import type { Plan, PlannedEntry, RefundSource, TransactionKind, TransactionRequest } from './plan.js';

export interface TransactionResult {
  transactionId: string;
  kind: TransactionKind;
  userId: number;
  amount: number; // the signed change to the player's wallet, in whole Coins
  balanceAfter: number;
  itemId: ItemId | null;
  createdAt: string;
}

export interface SubmitOutcome {
  result: TransactionResult;
  replayed: boolean;
}

export interface UnfulfilledPurchase {
  transactionId: string;
  itemId: ItemId;
  createdAt: string;
}

export interface LedgerService {
  submit(input: { principal: string; idempotencyKey: string; request: TransactionRequest }): Promise<SubmitOutcome>;
  refund(input: { principal: string; idempotencyKey: string; transactionId: string }): Promise<SubmitOutcome>;
  // Only a purchase that principal made counts; any other id is purchase_not_found.
  markFulfilled(transactionId: string, principal: string): Promise<void>;
  unfulfilledPurchases(userId: number): Promise<UnfulfilledPurchase[]>;
  systemBalance(accountId: string): Promise<number>;
}

export interface LedgerOptions {
  logger?: TransactionLogger;
}

// Every error the ledger answers with on purpose, and its HTTP status. Routes and the OpenAPI
// document read this list, so a client can rely on the codes staying stable.
export const LEDGER_ERROR_CODES = {
  invalid_request: 400,
  player_not_found: 404,
  transaction_not_found: 404,
  purchase_not_found: 404,
  idempotency_key_reuse: 409,
  already_refunded: 409,
  not_refundable: 409,
  insufficient_funds: 422,
  // The write may or may not have landed (a lost COMMIT), or lock contention outlasted the
  // retries. Either way the client retries with the same Idempotency-Key and the replay settles it.
  ledger_unavailable: 503,
} as const;

export type LedgerErrorCode = keyof typeof LEDGER_ERROR_CODES;

function ledgerError(code: LedgerErrorCode, message: string, options: { cause?: unknown; headers?: Record<string, string> } = {}): AppError {
  return new AppError(LEDGER_ERROR_CODES[code], code, message, options);
}

interface Prior {
  requestHash: string;
  result: TransactionResult;
}

interface WriteArgs {
  principal: string;
  idempotencyKey: string;
  hash: string;
  plan: Plan;
  refundOf: string | null;
}

function replay(prior: Prior, hash: string): SubmitOutcome {
  if (prior.requestHash !== hash) {
    throw ledgerError('idempotency_key_reuse', 'This Idempotency-Key was already used for a different request');
  }
  return { result: prior.result, replayed: true };
}

async function findByKey(executor: Db | PoolConnection, idempotencyKey: string): Promise<Prior | null> {
  const [rows] = await executor.execute<RowDataPacket[]>('SELECT request_hash, result FROM ledger_transactions WHERE idempotency_key = ?', [idempotencyKey]);
  const row = rows[0];
  return row ? { requestHash: String(row.request_hash), result: row.result as TransactionResult } : null;
}

// The signed change per player account, in account_id order. That order is the ledger's lock
// order, so two transactions that touch the same players always queue instead of deadlocking.
// System accounts are left out on purpose: their balances are SUM(ledger_entries), never a row
// that every earn and purchase would have to lock (ADR 0008).
function playerDeltas(plan: Plan): [string, number][] {
  const deltas = new Map<string, number>([[playerAccountId(plan.userId), 0]]);
  for (const entry of plan.entries) {
    if (isPlayerAccount(entry.accountId)) deltas.set(entry.accountId, (deltas.get(entry.accountId) ?? 0) + entry.amount);
  }
  return [...deltas].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function planOrRefuse(request: TransactionRequest): Plan {
  try {
    return planTransaction(request);
  } catch (error) {
    if (error instanceof RangeError) throw ledgerError('invalid_request', error.message);
    throw error;
  }
}

export function createLedgerService(db: Db, clock: Clock, options: LedgerOptions = {}): LedgerService {
  // Writes one planned transaction inside withTransaction. The steps run in a fixed order:
  //   1. Lock every player balance row involved, FOR UPDATE, sorted by account_id (S3-F3).
  //   2. Look the idempotency key up again. A request with the same key that held the lock before
  //      us has committed by now, so this sees it and replays it (S3-F1). Checking the key only
  //      before the transaction would let a retry of a purchase that just emptied the wallet
  //      answer a false 422. This is the transaction's first consistent (plain) read, so its
  //      snapshot is taken after the locks are held and includes everything committed before
  //      them. That only holds while withTransaction starts with a plain START TRANSACTION, never
  //      WITH CONSISTENT SNAPSHOT, and while no plain read runs before the balance lock. The read
  //      stays plain on purpose: a FOR SHARE here takes a gap lock on the missing key, which
  //      deadlocks against other players' inserts into the same gap (measured, Task 15).
  //   3. For a refund, check the source was not refunded already (the unique key is the backstop).
  //   4. Refuse a negative balance, then append the rows and move the player balances.
  async function record(conn: PoolConnection, args: WriteArgs): Promise<SubmitOutcome> {
    const { plan } = args;
    const deltas = playerDeltas(plan);
    const before = new Map<string, number>();
    for (const [account] of deltas) {
      const [rows] = await conn.execute<RowDataPacket[]>('SELECT balance FROM account_balances WHERE account_id = ? FOR UPDATE', [account]);
      if (!rows[0]) throw ledgerError('player_not_found', 'This player has not joined yet');
      before.set(account, Number(rows[0].balance));
    }

    const prior = await findByKey(conn, args.idempotencyKey);
    if (prior) return replay(prior, args.hash);

    if (args.refundOf !== null) {
      const [refunds] = await conn.execute<RowDataPacket[]>('SELECT 1 FROM ledger_transactions WHERE refund_of = ?', [args.refundOf]);
      if (refunds[0]) throw ledgerError('already_refunded', 'This transaction was already refunded');
    }

    const moves = deltas.map(([account, delta]) => {
      const next = (before.get(account) ?? 0) + delta;
      if (!Number.isSafeInteger(next)) throw ledgerError('invalid_request', 'The balance would leave the safe whole-number range');
      if (next < 0) throw ledgerError('insufficient_funds', 'Not enough Coins');
      return { account, delta, next };
    });

    const now = new Date(clock.now());
    const transactionId = randomUUID();
    const result: TransactionResult = {
      transactionId,
      kind: plan.kind,
      userId: plan.userId,
      amount: plan.playerDelta,
      balanceAfter: moves.find((move) => move.account === playerAccountId(plan.userId))?.next ?? 0,
      itemId: plan.itemId,
      createdAt: now.toISOString(),
    };
    await conn.execute(
      'INSERT INTO ledger_transactions (transaction_id, idempotency_key, request_hash, kind, principal, roblox_user_id, reason, metadata, refund_of, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [transactionId, args.idempotencyKey, args.hash, plan.kind, args.principal, plan.userId, plan.reason, JSON.stringify({ itemId: plan.itemId }), args.refundOf, JSON.stringify(result), now],
    );
    for (const entry of plan.entries) {
      await conn.execute('INSERT INTO ledger_entries (transaction_id, account_id, amount, created_at) VALUES (?, ?, ?, ?)', [transactionId, entry.accountId, entry.amount, now]);
    }
    for (const { account, delta, next } of moves) {
      if (delta !== 0) await conn.execute('UPDATE account_balances SET balance = ?, updated_at = ? WHERE account_id = ?', [next, now, account]);
    }
    return { result, replayed: false };
  }

  async function write(args: WriteArgs): Promise<SubmitOutcome> {
    try {
      return await withTransaction(db, (conn) => record(conn, args), { logger: options.logger });
    } catch (error) {
      if (error instanceof CommitOutcomeUnknownError) {
        throw ledgerError('ledger_unavailable', 'The ledger could not confirm this write; retry with the same Idempotency-Key', {
          cause: error,
          headers: { 'retry-after': '1' },
        });
      }
      if (isDuplicateKey(error)) {
        const key = duplicateKeyName(error);
        if (key?.endsWith('uq_ledger_refund_of')) throw ledgerError('already_refunded', 'This transaction was already refunded');
        // The balance locks only serialize one player's writes. The same key sent for two
        // different players races to the unique index instead, and the loser answers from the
        // winner's row: a 409, since the bodies differ.
        if (key?.endsWith('uq_ledger_idempotency_key')) {
          const raced = await findByKey(db, args.idempotencyKey);
          if (raced) return replay(raced, args.hash);
        }
      }
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'ER_LOCK_DEADLOCK' || code === 'ER_LOCK_WAIT_TIMEOUT') {
        throw ledgerError('ledger_unavailable', 'The ledger is busy; retry with the same Idempotency-Key', { cause: error, headers: { 'retry-after': '1' } });
      }
      throw error;
    }
  }

  // The source of a refund is always read back from the ledger by its id. Nothing about it (kind,
  // player, item, entries) is taken from the request, so a caller can only name what to undo.
  async function loadRefundSource(transactionId: string): Promise<RefundSource> {
    const [transactions] = await db.execute<RowDataPacket[]>('SELECT kind, roblox_user_id, metadata FROM ledger_transactions WHERE transaction_id = ?', [
      transactionId,
    ]);
    const source = transactions[0];
    if (!source) throw ledgerError('transaction_not_found', 'No such transaction');
    const [entries] = await db.execute<RowDataPacket[]>('SELECT account_id, amount FROM ledger_entries WHERE transaction_id = ? ORDER BY entry_id', [transactionId]);
    const storedItem = (source.metadata as { itemId?: unknown } | null)?.itemId;
    return {
      transactionId,
      kind: source.kind as TransactionKind,
      userId: Number(source.roblox_user_id),
      itemId: isItemId(storedItem) ? storedItem : null,
      entries: entries.map((e): PlannedEntry => ({ accountId: String(e.account_id), amount: Number(e.amount) })),
    };
  }

  return {
    async submit({ principal, idempotencyKey, request }) {
      const plan = planOrRefuse(request);
      const hash = requestHash(principal, request);
      // A fast path for the common retry. The authoritative check runs again under the lock.
      const prior = await findByKey(db, idempotencyKey);
      if (prior) return replay(prior, hash);
      return write({ principal, idempotencyKey, hash, plan, refundOf: null });
    },

    async refund({ principal, idempotencyKey, transactionId }) {
      const hash = requestHash(principal, { kind: 'refund', transactionId });
      const prior = await findByKey(db, idempotencyKey);
      if (prior) return replay(prior, hash);

      // Ledger rows never change, so reading the source before the transaction is safe.
      const source = await loadRefundSource(transactionId);
      let plan: Plan;
      try {
        plan = planRefund(source);
      } catch (error) {
        if (error instanceof RangeError) throw ledgerError('not_refundable', error.message);
        throw error;
      }
      return write({ principal, idempotencyKey, hash, plan, refundOf: transactionId });
    },

    async markFulfilled(transactionId, principal) {
      const [rows] = await db.execute<RowDataPacket[]>("SELECT principal FROM ledger_transactions WHERE transaction_id = ? AND kind = 'purchase'", [transactionId]);
      const owned = rows[0] !== undefined && String(rows[0].principal) === principal;
      if (!owned) throw ledgerError('purchase_not_found', 'No such purchase');
      // A repeat acknowledgement is a no-op update, which the insert-only trigger allows.
      await db.execute('INSERT INTO purchase_fulfillments (transaction_id, fulfilled_at) VALUES (?, ?) ON DUPLICATE KEY UPDATE transaction_id = transaction_id', [
        transactionId,
        new Date(clock.now()),
      ]);
    },

    async unfulfilledPurchases(userId) {
      const [rows] = await db.execute<RowDataPacket[]>(
        `SELECT t.transaction_id, JSON_UNQUOTE(JSON_EXTRACT(t.metadata, '$.itemId')) AS item_id, t.created_at
           FROM ledger_transactions t
           LEFT JOIN purchase_fulfillments f ON f.transaction_id = t.transaction_id
           LEFT JOIN ledger_transactions r ON r.refund_of = t.transaction_id
          WHERE t.roblox_user_id = ? AND t.kind = 'purchase' AND f.transaction_id IS NULL AND r.transaction_id IS NULL
          ORDER BY t.created_at, t.transaction_id
          LIMIT 100`,
        [userId],
      );
      return rows.map((row) => ({
        transactionId: String(row.transaction_id),
        itemId: row.item_id as ItemId,
        createdAt: new Date(row.created_at as Date).toISOString(),
      }));
    },

    // Derived from the entries on every call; no system balance row exists to drift or to lock.
    async systemBalance(accountId) {
      const [rows] = await db.execute<RowDataPacket[]>('SELECT COALESCE(SUM(amount), 0) AS total FROM ledger_entries WHERE account_id = ?', [accountId]);
      return Number(rows[0]?.total ?? 0);
    },
  };
}
