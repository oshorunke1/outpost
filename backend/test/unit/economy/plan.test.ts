import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { MINT_ACCOUNT, SINK_ACCOUNT, playerAccountId } from '../../../src/modules/economy/accounts.js';
import { CATALOG, ITEM_IDS, priceOf } from '../../../src/modules/economy/catalog.js';
import type { ItemId } from '../../../src/modules/economy/catalog.js';
import { MAX_EARN_PER_TRANSACTION, planRefund, planTransaction, requestHash, sumEntries } from '../../../src/modules/economy/plan.js';
import type { Plan, TransactionRequest } from '../../../src/modules/economy/plan.js';

const userIds = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });
const earnAmounts = fc.integer({ min: 1, max: MAX_EARN_PER_TRANSACTION });
const itemIds = fc.constantFrom(...ITEM_IDS);
const requests: fc.Arbitrary<TransactionRequest> = fc.oneof(
  fc.record({ kind: fc.constant('earn' as const), userId: userIds, amount: earnAmounts, reason: fc.constant('orbs' as const) }),
  fc.record({ kind: fc.constant('purchase' as const), userId: userIds, itemId: itemIds }),
);

function playerEntry(plan: Plan): number | undefined {
  return plan.entries.find((entry) => entry.accountId === playerAccountId(plan.userId))?.amount;
}

function refundOf(plan: Plan, transactionId = 't-1'): Plan {
  return planRefund({ transactionId, kind: plan.kind, userId: plan.userId, itemId: plan.itemId, entries: plan.entries });
}

describe('planTransaction', () => {
  // Invariant 1: every transaction's entries sum to zero.
  test('every earn sums to zero and pays the player exactly the amount', () => {
    fc.assert(
      fc.property(userIds, earnAmounts, (userId, amount) => {
        const plan = planTransaction({ kind: 'earn', userId, amount, reason: 'orbs' });
        expect(sumEntries(plan.entries)).toBe(0);
        expect(plan.playerDelta).toBe(amount);
        expect(plan.entries).toEqual([
          { accountId: MINT_ACCOUNT, amount: -amount },
          { accountId: playerAccountId(userId), amount },
        ]);
      }),
    );
  });

  test('every purchase sums to zero and charges the catalog price', () => {
    fc.assert(
      fc.property(userIds, itemIds, (userId, itemId) => {
        const plan = planTransaction({ kind: 'purchase', userId, itemId });
        expect(sumEntries(plan.entries)).toBe(0);
        expect(plan.playerDelta).toBe(-CATALOG[itemId].price);
        expect(plan.entries.find((e) => e.accountId === SINK_ACCOUNT)?.amount).toBe(CATALOG[itemId].price);
      }),
    );
  });

  test('every plan is zero-sum, whole, non-zero, and its playerDelta is the player entry', () => {
    fc.assert(
      fc.property(requests, (request) => {
        const plan = planTransaction(request);
        expect(sumEntries(plan.entries)).toBe(0);
        expect(plan.playerDelta).toBe(playerEntry(plan));
        for (const entry of plan.entries) {
          expect(Number.isSafeInteger(entry.amount)).toBe(true);
          expect(entry.amount).not.toBe(0);
        }
        expect(new Set(plan.entries.map((e) => e.accountId)).size).toBe(plan.entries.length);
      }),
    );
  });

  test('a refund exactly reverses its source, account by account', () => {
    fc.assert(
      fc.property(userIds, earnAmounts, itemIds, fc.boolean(), (userId, amount, itemId, isEarn) => {
        const source = isEarn ? planTransaction({ kind: 'earn', userId, amount, reason: 'orbs' }) : planTransaction({ kind: 'purchase', userId, itemId });
        const refund = planRefund({ transactionId: 't-1', kind: source.kind, userId, itemId: source.itemId, entries: source.entries });
        expect(sumEntries(refund.entries)).toBe(0);
        expect(refund.playerDelta).toBe(-source.playerDelta);
        for (const entry of source.entries) {
          const reversed = refund.entries.find((e) => e.accountId === entry.accountId);
          expect((reversed?.amount ?? 0) + entry.amount).toBe(0);
        }
      }),
    );
  });

  test('a refund negates every source entry exactly, in order, and keeps the item', () => {
    fc.assert(
      fc.property(requests, (request) => {
        const source = planTransaction(request);
        const refund = refundOf(source);
        expect(refund.kind).toBe('refund');
        expect(refund.userId).toBe(source.userId);
        expect(refund.itemId).toBe(source.itemId);
        expect(refund.entries).toEqual(source.entries.map((e) => ({ accountId: e.accountId, amount: -e.amount })));
        expect(refund.playerDelta).toBe(playerEntry(refund));
        expect(refund.playerDelta + source.playerDelta).toBe(0);
      }),
    );
  });

  test('a refund of a refund is refused', () => {
    expect(() => planRefund({ transactionId: 't', kind: 'refund', userId: 1, itemId: null, entries: [] })).toThrow(RangeError);
    fc.assert(
      fc.property(requests, (request) => {
        expect(() => refundOf(refundOf(planTransaction(request)))).toThrow(RangeError);
      }),
    );
  });

  test('a refund source that is empty, unbalanced, or not whole is refused', () => {
    const base = { transactionId: 't', kind: 'earn' as const, userId: 1, itemId: null };
    expect(() => planRefund({ ...base, entries: [] })).toThrow(RangeError);
    expect(() => planRefund({ ...base, entries: [{ accountId: playerAccountId(1), amount: 5 }] })).toThrow(RangeError);
    expect(() =>
      planRefund({
        ...base,
        entries: [
          { accountId: MINT_ACCOUNT, amount: -1.5 },
          { accountId: playerAccountId(1), amount: 1.5 },
        ],
      }),
    ).toThrow(RangeError);
    expect(() =>
      planRefund({
        ...base,
        entries: [
          { accountId: MINT_ACCOUNT, amount: 0 },
          { accountId: playerAccountId(1), amount: 0 },
        ],
      }),
    ).toThrow(RangeError);
  });

  test('earn amounts outside 1..1000 or not whole are refused', () => {
    for (const amount of [0, -0, -1, 1001, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2, 2 ** 64]) {
      expect(() => planTransaction({ kind: 'earn', userId: 1, amount, reason: 'orbs' })).toThrow(RangeError);
    }
    fc.assert(
      fc.property(
        fc.oneof(fc.integer({ max: 0 }), fc.integer({ min: MAX_EARN_PER_TRANSACTION + 1 }), fc.double().filter((n) => !Number.isInteger(n))),
        (amount) => {
          expect(() => planTransaction({ kind: 'earn', userId: 1, amount, reason: 'orbs' })).toThrow(RangeError);
        },
      ),
    );
  });

  test('values that only TypeScript forbids are still refused at runtime', () => {
    const loose = (request: unknown) => () => planTransaction(request as TransactionRequest);
    expect(loose({ kind: 'earn', userId: 1, amount: '5', reason: 'orbs' })).toThrow(RangeError);
    expect(loose({ kind: 'earn', userId: 1, amount: 5, reason: 'gift' })).toThrow(RangeError);
    expect(loose({ kind: 'purchase', userId: 1, itemId: 'toString' })).toThrow(RangeError);
    expect(loose({ kind: 'purchase', userId: 1, itemId: 'BlueHat' })).toThrow(RangeError);
    expect(loose({ kind: 'refund', userId: 1 })).toThrow(RangeError);
    for (const userId of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(loose({ kind: 'earn', userId, amount: 5, reason: 'orbs' })).toThrow(RangeError);
    }
  });

  test('every catalog price is a positive whole number', () => {
    for (const id of ITEM_IDS) expect(Number.isSafeInteger(CATALOG[id].price) && CATALOG[id].price > 0).toBe(true);
    expect(priceOf('RedHat')).toBe(25);
    expect(priceOf('GoldCrown')).toBe(100);
    expect(ITEM_IDS).toEqual(['RedHat', 'GoldCrown'] satisfies ItemId[]);
  });
});

describe('sumEntries', () => {
  test('refuses to add amounts that are not safe integers', () => {
    expect(() => sumEntries([{ accountId: 'a', amount: 0.5 }])).toThrow(RangeError);
    expect(() =>
      sumEntries([
        { accountId: 'a', amount: Number.MAX_SAFE_INTEGER },
        { accountId: 'b', amount: 1 },
      ]),
    ).toThrow(RangeError);
  });
});

describe('requestHash', () => {
  test('is stable for equal requests and differs for a different principal or body', () => {
    const body = { kind: 'earn', userId: 1, amount: 5, reason: 'orbs' };
    expect(requestHash('svc:game-server', body)).toBe(requestHash('svc:game-server', { reason: 'orbs', amount: 5, userId: 1, kind: 'earn' }));
    expect(requestHash('svc:other', body)).not.toBe(requestHash('svc:game-server', body));
    expect(requestHash('svc:game-server', { ...body, amount: 6 })).not.toBe(requestHash('svc:game-server', body));
  });

  test('binds the principal to the body for any body', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.jsonValue(), (first, second, body) => {
        fc.pre(first !== second);
        expect(requestHash(first, body)).not.toBe(requestHash(second, body));
        expect(requestHash(first, body)).toMatch(/^[0-9a-f]{64}$/);
      }),
    );
  });

  test('a principal cannot be shifted into the body to forge a match', () => {
    expect(requestHash('svc:a', { x: 1 })).not.toBe(requestHash('svc:', { a: { x: 1 } }));
    expect(requestHash('svc:a', 'b')).not.toBe(requestHash('svc:', 'ab'));
  });

  test('refuses a body canonical JSON cannot hold', () => {
    expect(() => requestHash('svc:a', { amount: Number.NaN })).toThrow(TypeError);
  });
});
