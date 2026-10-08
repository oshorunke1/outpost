import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createMysqlPlayersService } from '../../src/modules/players/playersService.js';
import { systemClock } from '../../src/platform/clock.js';
import { isDuplicateKey } from '../../src/platform/db.js';
import type { RowDataPacket } from '../../src/platform/db.js';
import { createIntegrationContext } from './support/context.js';
import type { IntegrationContext } from './support/context.js';

describe('ledger schema guards', () => {
  let ctx: IntegrationContext;
  const transactionId = randomUUID();

  const insertTransaction = (id: string, key: string, kind = 'earn', refundOf: string | null = null) =>
    ctx.db.query(
      "INSERT INTO ledger_transactions (transaction_id, idempotency_key, request_hash, kind, principal, roblox_user_id, reason, metadata, refund_of, result, created_at) VALUES (?, ?, REPEAT('a', 64), ?, 'svc:test', 1001, 'orbs', '{}', ?, '{}', UTC_TIMESTAMP(3))",
      [id, key, kind, refundOf],
    );

  beforeAll(async () => {
    ctx = await createIntegrationContext();
    await createMysqlPlayersService(ctx.db, systemClock).join(1001);
    await insertTransaction(transactionId, 'schema-test-key');
    await ctx.db.query("INSERT INTO ledger_entries (transaction_id, account_id, amount, created_at) VALUES (?, 'system:mint', -5, UTC_TIMESTAMP(3)), (?, 'player:1001', 5, UTC_TIMESTAMP(3))", [
      transactionId,
      transactionId,
    ]);
  });
  afterAll(async () => {
    await ctx.close();
  });

  // Invariant 5, enforced by the database itself.
  test('ledger rows cannot be updated or deleted', async () => {
    await expect(ctx.db.query("UPDATE ledger_transactions SET reason = 'x' WHERE transaction_id = ?", [transactionId])).rejects.toThrow('append-only');
    await expect(ctx.db.query('DELETE FROM ledger_transactions WHERE transaction_id = ?', [transactionId])).rejects.toThrow('append-only');
    await expect(ctx.db.query('UPDATE ledger_entries SET amount = 500 WHERE transaction_id = ?', [transactionId])).rejects.toThrow('append-only');
    await expect(ctx.db.query('DELETE FROM ledger_entries WHERE transaction_id = ?', [transactionId])).rejects.toThrow('append-only');
    // Even an UPDATE that would change nothing is refused, and the rows are untouched.
    await expect(ctx.db.query('UPDATE ledger_entries SET amount = amount WHERE transaction_id = ?', [transactionId])).rejects.toThrow('append-only');
    const [rows] = await ctx.db.query<RowDataPacket[]>('SELECT account_id, amount FROM ledger_entries WHERE transaction_id = ? ORDER BY entry_id', [transactionId]);
    expect(rows.map((row) => [String(row.account_id), Number(row.amount)])).toEqual([
      ['system:mint', -5],
      ['player:1001', 5],
    ]);
  });

  // A fulfilment is written once. Task 14 replays it with a no-op ON DUPLICATE KEY UPDATE, which
  // fires the update trigger, so the trigger allows a no-op and refuses any real change.
  test('purchase fulfilments are insert-only, and a no-op replay is allowed', async () => {
    const purchaseId = randomUUID();
    await insertTransaction(purchaseId, 'schema-purchase-key', 'purchase');
    await ctx.db.query("INSERT INTO purchase_fulfillments (transaction_id, fulfilled_at) VALUES (?, '2026-01-01 00:00:00.000')", [purchaseId]);
    await expect(
      ctx.db.query(
        "INSERT INTO purchase_fulfillments (transaction_id, fulfilled_at) VALUES (?, '2026-06-01 00:00:00.000') ON DUPLICATE KEY UPDATE transaction_id = transaction_id",
        [purchaseId],
      ),
    ).resolves.toBeDefined();
    await expect(ctx.db.query("UPDATE purchase_fulfillments SET fulfilled_at = '2027-01-01 00:00:00.000' WHERE transaction_id = ?", [purchaseId])).rejects.toThrow(
      'insert-only',
    );
    await expect(ctx.db.query('DELETE FROM purchase_fulfillments WHERE transaction_id = ?', [purchaseId])).rejects.toThrow('insert-only');
    const [rows] = await ctx.db.query<RowDataPacket[]>("SELECT DATE_FORMAT(fulfilled_at, '%Y-%m-%d') AS day FROM purchase_fulfillments WHERE transaction_id = ?", [purchaseId]);
    expect(rows.map((row) => String(row.day))).toEqual(['2026-01-01']);
  });

  // S3-F2: idempotency keys compare as exact bytes, so a client's 'Key' and 'key' are two requests.
  test('idempotency keys that differ only by case are distinct rows, and the same key collides', async () => {
    await insertTransaction(randomUUID(), 'Order-ABC');
    await expect(insertTransaction(randomUUID(), 'order-abc')).resolves.toBeDefined();
    await expect(insertTransaction(randomUUID(), 'ORDER-ABC')).resolves.toBeDefined();
    const duplicate = await insertTransaction(randomUUID(), 'Order-ABC').catch((error: unknown) => error);
    expect(isDuplicateKey(duplicate)).toBe(true);
    const [rows] = await ctx.db.query<RowDataPacket[]>("SELECT idempotency_key FROM ledger_transactions WHERE idempotency_key IN ('Order-ABC', 'order-abc', 'ORDER-ABC')");
    expect(rows.map((row) => row.idempotency_key as string).sort()).toEqual(['ORDER-ABC', 'Order-ABC', 'order-abc']);
  });

  test('every identifier column compares as exact bytes (utf8mb4_bin)', async () => {
    const [rows] = await ctx.db.query<RowDataPacket[]>(
      `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLLATION_NAME AS collation FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('ledger_transactions', 'ledger_entries', 'purchase_fulfillments') AND COLLATION_NAME IS NOT NULL
        ORDER BY TABLE_NAME, COLUMN_NAME`,
    );
    const collations = Object.fromEntries(rows.map((row) => [`${String(row.t)}.${String(row.c)}`, row.collation as string]));
    expect(collations['ledger_transactions.idempotency_key']).toBe('utf8mb4_bin');
    for (const column of [
      'ledger_transactions.transaction_id',
      'ledger_transactions.refund_of',
      'ledger_transactions.principal',
      'ledger_transactions.request_hash',
      'ledger_entries.transaction_id',
      'ledger_entries.account_id',
      'purchase_fulfillments.transaction_id',
    ]) {
      expect([column, collations[column]]).toEqual([column, 'utf8mb4_bin']);
    }
  });

  // Invariant 2, enforced by a CHECK constraint as the last line of defence.
  test('a player balance can never be written below zero', async () => {
    await expect(ctx.db.query("UPDATE account_balances SET balance = -1 WHERE account_id = 'player:1001'")).rejects.toMatchObject({
      code: 'ER_CHECK_CONSTRAINT_VIOLATED',
    });
  });

  // JavaScript reads balances and amounts as numbers, so nothing may exceed 2^53 - 1 (S3-F12 b).
  test('a balance or an entry beyond the safe integer range is refused', async () => {
    await expect(ctx.db.query("UPDATE account_balances SET balance = 9007199254740992 WHERE account_id = 'player:1001'")).rejects.toMatchObject({
      code: 'ER_CHECK_CONSTRAINT_VIOLATED',
    });
    await expect(
      ctx.db.query("INSERT INTO ledger_entries (transaction_id, account_id, amount, created_at) VALUES (?, 'player:1001', -9007199254740992, UTC_TIMESTAMP(3))", [transactionId]),
    ).rejects.toMatchObject({ code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
  });

  test('a zero amount entry is refused', async () => {
    await expect(
      ctx.db.query("INSERT INTO ledger_entries (transaction_id, account_id, amount, created_at) VALUES (?, 'player:1001', 0, UTC_TIMESTAMP(3))", [transactionId]),
    ).rejects.toMatchObject({ code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
  });

  test('an entry for an unknown account or transaction is refused', async () => {
    await expect(
      ctx.db.query("INSERT INTO ledger_entries (transaction_id, account_id, amount, created_at) VALUES (?, 'PLAYER:1001', 1, UTC_TIMESTAMP(3))", [transactionId]),
    ).rejects.toMatchObject({ code: 'ER_NO_REFERENCED_ROW_2' });
    await expect(
      ctx.db.query("INSERT INTO ledger_entries (transaction_id, account_id, amount, created_at) VALUES (?, 'player:1001', 1, UTC_TIMESTAMP(3))", [randomUUID()]),
    ).rejects.toMatchObject({ code: 'ER_NO_REFERENCED_ROW_2' });
  });

  test('a transaction for a player who never joined is refused (fk_ledger_player)', async () => {
    await expect(
      ctx.db.query(
        "INSERT INTO ledger_transactions (transaction_id, idempotency_key, request_hash, kind, principal, roblox_user_id, reason, metadata, result, created_at) VALUES (?, 'no-player', REPEAT('a', 64), 'earn', 'svc:test', 424242, 'orbs', '{}', '{}', UTC_TIMESTAMP(3))",
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ code: 'ER_NO_REFERENCED_ROW_2' });
  });

  test('only a refund names a refund_of, and each transaction is refunded at most once', async () => {
    await expect(insertTransaction(randomUUID(), 'refund-without-source', 'refund')).rejects.toMatchObject({ code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
    await expect(insertTransaction(randomUUID(), 'earn-with-source', 'earn', transactionId)).rejects.toMatchObject({ code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
    await expect(insertTransaction(randomUUID(), 'first-refund', 'refund', transactionId)).resolves.toBeDefined();
    const second = await insertTransaction(randomUUID(), 'second-refund', 'refund', transactionId).catch((error: unknown) => error);
    expect(isDuplicateKey(second)).toBe(true);
  });

  test('an empty idempotency key is refused', async () => {
    await expect(insertTransaction(randomUUID(), '')).rejects.toMatchObject({ code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
  });

  // S3-F3: Task 14 locks the player's account_balances row FOR UPDATE first, by primary key, so
  // the lock is one row and never a gap or table lock.
  test('the balance lock Task 14 takes first is a primary key lookup', async () => {
    const [plan] = await ctx.db.query<RowDataPacket[]>("EXPLAIN SELECT balance FROM account_balances WHERE account_id = 'player:1001' FOR UPDATE");
    expect(plan[0]).toMatchObject({ type: 'const', key: 'PRIMARY' });
    const [indexes] = await ctx.db.query<RowDataPacket[]>(
      `SELECT DISTINCT TABLE_NAME AS t, INDEX_NAME AS i FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('ledger_transactions', 'ledger_entries')`,
    );
    expect(indexes.map((row) => `${String(row.t)}.${String(row.i)}`).sort()).toEqual([
      'ledger_entries.PRIMARY',
      'ledger_entries.ix_entries_account',
      'ledger_entries.ix_entries_transaction',
      'ledger_transactions.PRIMARY',
      'ledger_transactions.ix_ledger_user_created',
      'ledger_transactions.uq_ledger_idempotency_key',
      'ledger_transactions.uq_ledger_refund_of',
    ]);
  });
});
