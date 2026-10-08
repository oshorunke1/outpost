import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createLedgerService } from '../../src/modules/economy/ledger.js';
import type { LedgerService } from '../../src/modules/economy/ledger.js';
import { createMysqlPlayersService } from '../../src/modules/players/playersService.js';
import { systemClock } from '../../src/platform/clock.js';
import type { Db, PoolConnection, RowDataPacket } from '../../src/platform/db.js';
import { createIntegrationContext } from './support/context.js';
import type { IntegrationContext } from './support/context.js';

const GAME = 'svc:game-server';
let nextUser = 5000;

// A pool whose connections fail their COMMIT, either before or after the server applied it. The
// connection is wrapped, never patched, so the real pooled connection stays clean for reuse.
function failingCommitDb(db: Db, mode: 'before-apply' | 'after-apply'): Db {
  const wrap = (conn: PoolConnection): PoolConnection =>
    new Proxy(conn, {
      get(target, prop) {
        if (prop === 'commit') {
          return async () => {
            if (mode === 'after-apply') await target.commit();
            else await target.rollback();
            throw Object.assign(new Error('Connection lost: The server closed the connection.'), { code: 'PROTOCOL_CONNECTION_LOST' });
          };
        }
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'getConnection') return async () => wrap(await target.getConnection());
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

describe('ledger invariants on MySQL', () => {
  let ctx: IntegrationContext;
  let ledger: LedgerService;
  beforeAll(async () => {
    ctx = await createIntegrationContext();
    ledger = createLedgerService(ctx.db, systemClock);
  });
  afterAll(async () => {
    await ctx.close();
  });

  async function newPlayer(coins = 0): Promise<number> {
    nextUser += 1;
    const userId = nextUser;
    await createMysqlPlayersService(ctx.db, systemClock).join(userId);
    if (coins > 0) await ledger.submit({ principal: GAME, idempotencyKey: `seed-${randomUUID()}`, request: { kind: 'earn', userId, amount: coins, reason: 'orbs' } });
    return userId;
  }
  const key = () => `test-${randomUUID()}`;
  const count = async (table: 'ledger_transactions' | 'ledger_entries') => {
    const [rows] = await ctx.db.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM ??', [table]);
    return Number(rows[0]?.n);
  };
  const balance = async (userId: number) => {
    const [rows] = await ctx.db.query<RowDataPacket[]>('SELECT balance FROM account_balances WHERE account_id = ?', [`player:${userId}`]);
    return Number(rows[0]?.balance);
  };

  // S3-F12: the materialized balances must agree with the entries they summarize, and the whole
  // ledger must sum to zero. Run after the concurrent tests, so it checks what they left behind.
  async function expectReconciled(): Promise<void> {
    const [total] = await ctx.db.query<RowDataPacket[]>('SELECT COALESCE(SUM(amount), 0) AS total FROM ledger_entries');
    expect(Number(total[0]?.total)).toBe(0);
    const [unbalanced] = await ctx.db.query<RowDataPacket[]>('SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING SUM(amount) <> 0');
    expect(unbalanced).toEqual([]);
    const [sums] = await ctx.db.query<RowDataPacket[]>(
      `SELECT (SELECT COALESCE(SUM(b.balance), 0) FROM account_balances b JOIN accounts a ON a.account_id = b.account_id WHERE a.kind = 'player') AS balances,
              (SELECT COALESCE(SUM(e.amount), 0) FROM ledger_entries e JOIN accounts a ON a.account_id = e.account_id WHERE a.kind = 'player') AS entries`,
    );
    expect(Number(sums[0]?.balances)).toBe(Number(sums[0]?.entries));
    const [drift] = await ctx.db.query<RowDataPacket[]>(
      `SELECT b.account_id, b.balance, COALESCE(SUM(e.amount), 0) AS entries
         FROM account_balances b LEFT JOIN ledger_entries e ON e.account_id = b.account_id
        GROUP BY b.account_id, b.balance
       HAVING b.balance <> COALESCE(SUM(e.amount), 0)`,
    );
    expect(drift).toEqual([]);
    const [systemRows] = await ctx.db.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM account_balances WHERE account_id LIKE 'system:%'");
    expect(Number(systemRows[0]?.n)).toBe(0); // system balances are derived from entries, never stored
  }

  test('an earn and a purchase move Coins and report the balance after', async () => {
    const userId = await newPlayer();
    const earned = await ledger.submit({ principal: GAME, idempotencyKey: key(), request: { kind: 'earn', userId, amount: 30, reason: 'orbs' } });
    expect(earned).toMatchObject({ replayed: false, result: { kind: 'earn', userId, amount: 30, balanceAfter: 30, itemId: null } });
    const bought = await ledger.submit({ principal: GAME, idempotencyKey: key(), request: { kind: 'purchase', userId, itemId: 'RedHat' } });
    expect(bought.result).toMatchObject({ kind: 'purchase', amount: -25, balanceAfter: 5, itemId: 'RedHat' });
    expect(await balance(userId)).toBe(5);
  });

  // Invariant 1
  test('every transaction sums to zero and so does the whole ledger', async () => {
    const [unbalanced] = await ctx.db.query<RowDataPacket[]>('SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING SUM(amount) <> 0');
    expect(unbalanced).toEqual([]);
    const [total] = await ctx.db.query<RowDataPacket[]>('SELECT COALESCE(SUM(amount), 0) AS total FROM ledger_entries');
    expect(Number(total[0]?.total)).toBe(0);
    expect((await ledger.systemBalance('system:mint')) + (await ledger.systemBalance('system:sink'))).toBeLessThanOrEqual(0);
  });

  // Invariant 2
  test('a purchase the player cannot afford is 422 and writes nothing', async () => {
    const userId = await newPlayer(10);
    const before = await count('ledger_transactions');
    await expect(ledger.submit({ principal: GAME, idempotencyKey: key(), request: { kind: 'purchase', userId, itemId: 'GoldCrown' } })).rejects.toMatchObject({
      statusCode: 422,
      code: 'insufficient_funds',
    });
    expect(await count('ledger_transactions')).toBe(before);
    expect(await balance(userId)).toBe(10);
  });

  // Invariant 3
  test('replaying a key returns the first result and writes nothing; a different body is 409', async () => {
    const userId = await newPlayer();
    const idempotencyKey = key();
    const request = { kind: 'earn', userId, amount: 7, reason: 'orbs' } as const;
    const first = await ledger.submit({ principal: GAME, idempotencyKey, request });
    const entriesBefore = await count('ledger_entries');
    const again = await ledger.submit({ principal: GAME, idempotencyKey, request });
    expect(again).toEqual({ result: first.result, replayed: true });
    expect(await count('ledger_entries')).toBe(entriesBefore);
    await expect(ledger.submit({ principal: GAME, idempotencyKey, request: { ...request, amount: 8 } })).rejects.toMatchObject({
      statusCode: 409,
      code: 'idempotency_key_reuse',
    });
    expect(await balance(userId)).toBe(7);
  });

  // Review Focus 1: a retry racing its own original.
  test('two requests with one key at the same time make one transaction', async () => {
    const userId = await newPlayer();
    const idempotencyKey = key();
    const request = { kind: 'earn', userId, amount: 11, reason: 'orbs' } as const;
    const [a, b] = await Promise.all([ledger.submit({ principal: GAME, idempotencyKey, request }), ledger.submit({ principal: GAME, idempotencyKey, request })]);
    expect(a.result.transactionId).toBe(b.result.transactionId);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(await balance(userId)).toBe(11);
  });

  // S3-F1: the losers queue on the balance lock, and by the time they hold it the wallet is empty.
  // Without the key re-check under the lock they would answer a false 422 for a purchase that
  // in fact went through.
  test('racing retries of one purchase from a player who can afford exactly one all get the original result', async () => {
    const userId = await newPlayer(25);
    const idempotencyKey = key();
    const request = { kind: 'purchase', userId, itemId: 'RedHat' } as const;
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => ledger.submit({ principal: GAME, idempotencyKey, request })));
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason as unknown);
    expect(rejected).toEqual([]);
    const outcomes = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    expect(outcomes.filter((o) => !o.replayed)).toHaveLength(1);
    const original = outcomes.find((o) => !o.replayed)?.result;
    for (const outcome of outcomes) expect(outcome.result).toEqual(original);
    expect(original).toMatchObject({ kind: 'purchase', amount: -25, balanceAfter: 0 });
    const [rows] = await ctx.db.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM ledger_transactions WHERE idempotency_key = ?', [idempotencyKey]);
    expect(Number(rows[0]?.n)).toBe(1);
    expect(await balance(userId)).toBe(0);
  });

  // The balance locks do not serialize two different players, so a key shared across players is
  // caught by the unique index instead, and the loser must still get a clean 409, not a 500.
  test('one key used for two players at once is one success and one 409 idempotency_key_reuse', async () => {
    const [first, second] = [await newPlayer(), await newPlayer()];
    const idempotencyKey = key();
    for (let round = 0; round < 5; round += 1) {
      const roundKey = `${idempotencyKey}-${round}`;
      const results = await Promise.allSettled(
        [first, second].map((userId) => ledger.submit({ principal: GAME, idempotencyKey: roundKey, request: { kind: 'earn', userId, amount: 1, reason: 'orbs' } })),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const loser = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(loser?.reason).toMatchObject({ statusCode: 409, code: 'idempotency_key_reuse' });
    }
    expect((await balance(first)) + (await balance(second))).toBe(5);
  });

  // Invariant 4
  test('concurrent debits on one wallet serialize: one crown, seven refusals, balance zero', async () => {
    const userId = await newPlayer(100);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => ledger.submit({ principal: GAME, idempotencyKey: key(), request: { kind: 'purchase', userId, itemId: 'GoldCrown' } })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const rejected of results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')) {
      expect(rejected.reason).toMatchObject({ statusCode: 422, code: 'insufficient_funds' });
    }
    expect(await balance(userId)).toBe(0);
  });

  test('concurrent earns all land', async () => {
    const userId = await newPlayer();
    await Promise.all(Array.from({ length: 20 }, () => ledger.submit({ principal: GAME, idempotencyKey: key(), request: { kind: 'earn', userId, amount: 10, reason: 'orbs' } })));
    expect(await balance(userId)).toBe(200);
  });

  // S3-F3 and S3-F12: earns, purchases and rejoins over a few players, all at once. Rejoins hold
  // the players row the ledger's foreign key needs, which is where the old deadlock came from.
  test('60 concurrent earns, purchases and rejoins give no 5xx and leave the ledger reconciled', async () => {
    const userIds = [await newPlayer(50), await newPlayer(50), await newPlayer(50)];
    const players = createMysqlPlayersService(ctx.db, systemClock);
    const operations = Array.from({ length: 60 }, (_, i) => {
      const userId = userIds[i % userIds.length] ?? 0;
      switch (i % 3) {
        case 0:
          return ledger.submit({ principal: GAME, idempotencyKey: key(), request: { kind: 'earn', userId, amount: 5, reason: 'orbs' } });
        case 1:
          return ledger.submit({ principal: GAME, idempotencyKey: key(), request: { kind: 'purchase', userId, itemId: 'RedHat' } });
        default:
          return players.join(userId);
      }
    });
    const results = await Promise.allSettled(operations);
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason as { code?: unknown; statusCode?: unknown });
    // Only a clean refusal is allowed; a deadlock that escaped the retry would show up here.
    for (const failure of failures) expect(failure).toMatchObject({ statusCode: 422, code: 'insufficient_funds' });
    await expectReconciled();
  });

  // Invariant 5
  test('a refund is a compensating transaction and the original stays untouched', async () => {
    const userId = await newPlayer(30);
    const purchase = await ledger.submit({ principal: GAME, idempotencyKey: key(), request: { kind: 'purchase', userId, itemId: 'RedHat' } });
    const refund = await ledger.refund({ principal: GAME, idempotencyKey: key(), transactionId: purchase.result.transactionId });
    expect(refund.result).toMatchObject({ kind: 'refund', userId, amount: 25, balanceAfter: 30, itemId: 'RedHat' });
    const [rows] = await ctx.db.query<RowDataPacket[]>('SELECT result FROM ledger_transactions WHERE transaction_id = ?', [purchase.result.transactionId]);
    expect(rows[0]?.result).toEqual(purchase.result);
    await expect(ledger.refund({ principal: GAME, idempotencyKey: key(), transactionId: purchase.result.transactionId })).rejects.toMatchObject({
      statusCode: 409,
      code: 'already_refunded',
    });
    await expect(ledger.refund({ principal: GAME, idempotencyKey: key(), transactionId: refund.result.transactionId })).rejects.toMatchObject({
      statusCode: 409,
      code: 'not_refundable',
    });
    expect(await balance(userId)).toBe(30);
  });

  test('two different refunds of one purchase at once: one lands, the rest are 409 already_refunded', async () => {
    const userId = await newPlayer(25);
    const purchase = await ledger.submit({ principal: GAME, idempotencyKey: key(), request: { kind: 'purchase', userId, itemId: 'RedHat' } });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => ledger.refund({ principal: GAME, idempotencyKey: key(), transactionId: purchase.result.transactionId })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const rejected of results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')) {
      expect(rejected.reason).toMatchObject({ statusCode: 409, code: 'already_refunded' });
    }
    expect(await balance(userId)).toBe(25);
  });

  // The refund's kind, player and entries come from the stored transaction. A caller that sends
  // extra fields (a cast, or a route schema that drifted) must not be able to steer any of them.
  test('a refund ignores anything in the request but the transaction id', async () => {
    const owner = await newPlayer(25);
    const bystander = await newPlayer(0);
    const purchase = await ledger.submit({ principal: GAME, idempotencyKey: key(), request: { kind: 'purchase', userId: owner, itemId: 'RedHat' } });
    const forged = {
      principal: GAME,
      idempotencyKey: key(),
      transactionId: purchase.result.transactionId,
      userId: bystander,
      kind: 'earn',
      itemId: 'GoldCrown',
      amount: 1000,
      entries: [
        { accountId: 'system:mint', amount: -1000 },
        { accountId: `player:${bystander}`, amount: 1000 },
      ],
    } as unknown as Parameters<LedgerService['refund']>[0];
    const refund = await ledger.refund(forged);
    expect(refund.result).toMatchObject({ kind: 'refund', userId: owner, amount: 25, balanceAfter: 25, itemId: 'RedHat' });
    expect(await balance(owner)).toBe(25);
    expect(await balance(bystander)).toBe(0);
    const [entries] = await ctx.db.query<RowDataPacket[]>('SELECT account_id, amount FROM ledger_entries WHERE transaction_id = ? ORDER BY account_id', [
      refund.result.transactionId,
    ]);
    expect(entries.map((e) => ({ accountId: String(e.account_id), amount: Number(e.amount) }))).toEqual([
      { accountId: `player:${owner}`, amount: 25 },
      { accountId: 'system:sink', amount: -25 },
    ]);
  });

  test('refunding a transaction that does not exist is 404 transaction_not_found', async () => {
    await expect(ledger.refund({ principal: GAME, idempotencyKey: key(), transactionId: randomUUID() })).rejects.toMatchObject({
      statusCode: 404,
      code: 'transaction_not_found',
    });
  });

  test('a player who never joined is 404', async () => {
    await expect(ledger.submit({ principal: GAME, idempotencyKey: key(), request: { kind: 'earn', userId: 999_999_999, amount: 1, reason: 'orbs' } })).rejects.toMatchObject({
      statusCode: 404,
      code: 'player_not_found',
    });
  });

  test('a request the planner refuses is 400 invalid_request and writes nothing', async () => {
    const userId = await newPlayer();
    const before = await count('ledger_transactions');
    const bad = { kind: 'earn', userId, amount: 1.5, reason: 'orbs' } as const;
    await expect(ledger.submit({ principal: GAME, idempotencyKey: key(), request: bad })).rejects.toMatchObject({
      statusCode: 400,
      code: 'invalid_request',
    });
    expect(await count('ledger_transactions')).toBe(before);
  });

  // A dropped connection during COMMIT leaves the outcome unknown. The ledger answers 503 so the
  // client retries with the same key, and the replay then tells the truth either way.
  test.each(['before-apply', 'after-apply'] as const)('a commit lost %s is 503 ledger_unavailable and a same-key retry settles it', async (mode) => {
    const userId = await newPlayer();
    const idempotencyKey = key();
    const request = { kind: 'earn', userId, amount: 9, reason: 'orbs' } as const;
    const flaky = createLedgerService(failingCommitDb(ctx.db, mode), systemClock);
    await expect(flaky.submit({ principal: GAME, idempotencyKey, request })).rejects.toMatchObject({ statusCode: 503, code: 'ledger_unavailable' });
    const retried = await ledger.submit({ principal: GAME, idempotencyKey, request });
    expect(retried.replayed).toBe(mode === 'after-apply');
    expect(retried.result).toMatchObject({ amount: 9, balanceAfter: 9 });
    expect(await balance(userId)).toBe(9);
  });

  test('unfulfilled purchases show up until fulfilled, and refunded ones drop out', async () => {
    const userId = await newPlayer(200);
    const hat = await ledger.submit({ principal: GAME, idempotencyKey: key(), request: { kind: 'purchase', userId, itemId: 'RedHat' } });
    const crown = await ledger.submit({ principal: GAME, idempotencyKey: key(), request: { kind: 'purchase', userId, itemId: 'GoldCrown' } });
    // Both rows can share a millisecond, so compare as a set.
    expect((await ledger.unfulfilledPurchases(userId)).map((p) => p.itemId).sort()).toEqual(['GoldCrown', 'RedHat']);
    await ledger.markFulfilled(hat.result.transactionId);
    await ledger.markFulfilled(hat.result.transactionId); // a repeat ack is harmless
    await ledger.refund({ principal: GAME, idempotencyKey: key(), transactionId: crown.result.transactionId });
    expect(await ledger.unfulfilledPurchases(userId)).toEqual([]);
    await expect(ledger.markFulfilled(randomUUID())).rejects.toMatchObject({ statusCode: 404, code: 'purchase_not_found' });
  });

  // Last, so it reconciles everything every test above wrote.
  test('the whole ledger reconciles with the stored balances', async () => {
    await expectReconciled();
  });
});
