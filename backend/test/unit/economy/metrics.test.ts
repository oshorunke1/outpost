import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { buildApp } from '../../../src/app.js';
import { createMemoryAppDeps } from '../../../src/memoryDeps.js';
import type { LedgerService, SubmitOutcome } from '../../../src/modules/economy/ledger.js';
import { AppError } from '../../../src/platform/errors.js';
import { counterValue } from '../../support/metrics.js';
import { bearer, gameToken } from '../../support/tokens.js';

const result = {
  transactionId: randomUUID(),
  kind: 'purchase' as const,
  userId: 1001,
  amount: -50,
  balanceAfter: 0,
  itemId: 'RedHat' as const,
  createdAt: new Date(0).toISOString(),
};

function ledgerAnswering(answer: () => Promise<SubmitOutcome>): LedgerService {
  const unused = async (): Promise<never> => Promise.reject(new Error('not used'));
  return { submit: answer, refund: unused, markFulfilled: unused, unfulfilledPurchases: unused, systemBalance: unused };
}

async function submitWith(answer: () => Promise<SubmitOutcome>, payload: object) {
  const memory = await createMemoryAppDeps({ overrides: { ledger: ledgerAnswering(answer) } });
  const app = await buildApp(memory.deps);
  const headers = { ...bearer(await gameToken(memory.deps.tokens)), 'idempotency-key': 'job-1:1001:1' };
  const response = await app.inject({ method: 'POST', url: '/v1/economy/transactions', headers, payload });
  return { response, metrics: memory.deps.metrics };
}

const purchase = { kind: 'purchase', userId: 1001, itemId: 'RedHat' };
const earn = { kind: 'earn', userId: 1001, amount: 10, reason: 'orbs' };

describe('ledger counters', () => {
  test('a new transaction counts as created under its kind', async () => {
    const { response, metrics } = await submitWith(async () => ({ result, replayed: false }), purchase);
    expect(response.statusCode).toBe(201);
    expect(await counterValue(metrics.ledgerTransactions, { kind: 'purchase', outcome: 'created' })).toBe(1);
    expect(await counterValue(metrics.idempotentReplays)).toBe(0);
  });

  test('a replay counts as replayed and as an idempotent replay', async () => {
    const { response, metrics } = await submitWith(async () => ({ result: { ...result, kind: 'earn', amount: 10, itemId: null }, replayed: true }), earn);
    expect(response.statusCode).toBe(200);
    expect(await counterValue(metrics.ledgerTransactions, { kind: 'earn', outcome: 'replayed' })).toBe(1);
    expect(await counterValue(metrics.ledgerTransactions, { kind: 'earn', outcome: 'created' })).toBe(0);
    expect(await counterValue(metrics.idempotentReplays)).toBe(1);
  });

  test.each([
    ['insufficient_funds', 422],
    ['idempotency_key_reuse', 409],
    ['player_not_found', 404],
    ['ledger_unavailable', 503],
  ])('a ledger refusal counts under its error code %s', async (code, status) => {
    const { response, metrics } = await submitWith(async () => Promise.reject(new AppError(status, code, 'refused')), purchase);
    expect(response.statusCode).toBe(status);
    expect(await counterValue(metrics.ledgerTransactions, { kind: 'purchase', outcome: code })).toBe(1);
    expect(await counterValue(metrics.ledgerTransactions, { kind: 'purchase', outcome: 'created' })).toBe(0);
  });

  test('an unexpected failure counts as other, never with its message', async () => {
    const { response, metrics } = await submitWith(async () => Promise.reject(new Error('socket hang up for player 1001')), earn);
    expect(response.statusCode).toBe(500);
    expect(await counterValue(metrics.ledgerTransactions, { kind: 'earn', outcome: 'other' })).toBe(1);
    expect(await metrics.registry.metrics()).not.toContain('socket hang up');
  });

  // M3: only the ledger's own codes become label values, so a code from another layer cannot add series.
  test('an AppError with a code the ledger does not define counts as other', async () => {
    const { response, metrics } = await submitWith(async () => Promise.reject(new AppError(409, 'made_up_code_42', 'refused')), purchase);
    expect(response.statusCode).toBe(409);
    expect(await counterValue(metrics.ledgerTransactions, { kind: 'purchase', outcome: 'other' })).toBe(1);
    expect(await metrics.registry.metrics()).not.toContain('made_up_code_42');
  });
});
