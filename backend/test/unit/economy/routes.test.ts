import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../../../src/app.js';
import { createMemoryAppDeps } from '../../../src/memoryDeps.js';
import type { LedgerService, TransactionResult } from '../../../src/modules/economy/ledger.js';
import type { ZodApp } from '../../../src/platform/http.js';
import { bearer, gameToken } from '../../support/tokens.js';

function recordingLedger(replayed = false) {
  const calls: unknown[] = [];
  const result: TransactionResult = {
    transactionId: randomUUID(),
    kind: 'earn',
    userId: 1001,
    amount: 10,
    balanceAfter: 10,
    itemId: null,
    createdAt: new Date(0).toISOString(),
  };
  const ledger: LedgerService = {
    submit: async (input) => {
      calls.push(input);
      return { result, replayed };
    },
    refund: async () => Promise.reject(new Error('not used')),
    markFulfilled: async (id, principal) => void calls.push({ fulfilled: id, principal }),
    unfulfilledPurchases: async () => [],
    systemBalance: async () => 0,
  };
  return { ledger, calls, result };
}

let app: ZodApp;
let calls: unknown[];
let headers: Record<string, string>;

async function setup(replayed = false) {
  const recording = recordingLedger(replayed);
  const memory = await createMemoryAppDeps({ overrides: { ledger: recording.ledger } });
  app = await buildApp(memory.deps);
  calls = recording.calls;
  headers = { ...bearer(await gameToken(memory.deps.tokens)), 'idempotency-key': 'job-1:1001:1' };
}

beforeEach(async () => {
  await setup();
});

const post = (payload: unknown, extra: Record<string, string | undefined> = {}) =>
  app.inject({ method: 'POST', url: '/v1/economy/transactions', headers: { ...headers, ...extra } as Record<string, string>, payload: payload as object });

const earn = { kind: 'earn', userId: 1001, amount: 10, reason: 'orbs' };

describe('POST /v1/economy/transactions', () => {
  test('a valid earn reaches the ledger with the principal and the key', async () => {
    const response = await post(earn);
    expect(response.statusCode).toBe(201);
    expect(response.headers['idempotent-replayed']).toBeUndefined();
    expect(response.json()).toMatchObject({ kind: 'earn', balanceAfter: 10, replayed: false });
    expect(calls).toEqual([{ principal: 'svc:game-server', idempotencyKey: 'job-1:1001:1', request: earn }]);
  });

  test('a legacy_migration earn reaches the ledger with its reason', async () => {
    const legacy = { kind: 'earn', userId: 1001, amount: 1000, reason: 'legacy_migration' };
    const response = await post(legacy, { 'idempotency-key': 'legacy-1001-1' });
    expect(response.statusCode).toBe(201);
    expect(calls).toEqual([{ principal: 'svc:game-server', idempotencyKey: 'legacy-1001-1', request: legacy }]);
  });

  test('a valid purchase sends only the item id, never a price', async () => {
    const response = await post({ kind: 'purchase', userId: 1001, itemId: 'RedHat' });
    expect(response.statusCode).toBe(201);
    expect(calls).toEqual([{ principal: 'svc:game-server', idempotencyKey: 'job-1:1001:1', request: { kind: 'purchase', userId: 1001, itemId: 'RedHat' } }]);
  });

  test('the reply body keeps a fixed key order whatever order the ledger hands back', async () => {
    const response = await post(earn);
    expect(Object.keys(JSON.parse(response.body) as object)).toEqual([
      'transactionId',
      'kind',
      'userId',
      'amount',
      'balanceAfter',
      'itemId',
      'createdAt',
      'replayed',
    ]);
  });

  test('a replay is 200 with the idempotent-replayed header', async () => {
    await setup(true);
    const response = await post(earn);
    expect(response.statusCode).toBe(200);
    expect(response.headers['idempotent-replayed']).toBe('true');
    expect(response.json()).toMatchObject({ replayed: true });
  });

  test('the Idempotency-Key header is required and checked', async () => {
    for (const value of [undefined, '', 'short', 'seven77', 'has space in it', 'x'.repeat(129), 'semi;colon-key', 'slash/key/12', 'ünïcode-key']) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/economy/transactions',
        headers: value === undefined ? { authorization: headers.authorization ?? '' } : { ...headers, 'idempotency-key': value },
        payload: earn,
      });
      expect({ value, status: response.statusCode, error: response.json<{ error: string }>().error }).toEqual({ value, status: 400, error: 'invalid_request' });
    }
    expect(calls).toEqual([]);
  });

  test('the shortest and longest allowed keys get through', async () => {
    expect((await post(earn, { 'idempotency-key': 'a:b_c-d1' })).statusCode).toBe(201);
    expect((await post(earn, { 'idempotency-key': 'k'.repeat(128) })).statusCode).toBe(201);
    expect(calls).toHaveLength(2);
  });

  test('a client-sent price, an unknown item and an over-cap earn are refused', async () => {
    const refused = [
      { kind: 'purchase', userId: 1001, itemId: 'RedHat', price: 0 },
      { kind: 'purchase', userId: 1001, itemId: 'Sword' },
      { kind: 'purchase', userId: 1001, itemId: 'toString' },
      { kind: 'purchase', userId: 1001 },
      { kind: 'earn', userId: 1001, amount: 1001, reason: 'orbs' },
      { kind: 'earn', userId: '1001', amount: 5, reason: 'orbs' },
    ];
    for (const payload of refused) {
      const response = await post(payload);
      expect({ payload, status: response.statusCode, error: response.json<{ error: string }>().error }).toEqual({ payload, status: 400, error: 'invalid_request' });
    }
    expect(calls).toEqual([]);
  });

  test('extra fields, unknown kinds, bad amounts, bad reasons and bad userIds are all 400 invalid_request', async () => {
    const refused = [
      { ...earn, extra: true },
      { ...earn, balanceAfter: 999 },
      { ...earn, kind: 'refund' },
      { ...earn, kind: 'mint' },
      { userId: 1001, amount: 10, reason: 'orbs' },
      { ...earn, amount: 0 },
      { ...earn, amount: -5 },
      { ...earn, amount: 1.5 },
      { ...earn, amount: '10' },
      { ...earn, amount: Number.MAX_SAFE_INTEGER },
      { ...earn, reason: 'admin' },
      { ...earn, reason: 'Legacy_Migration' },
      { ...earn, reason: undefined },
      { ...earn, userId: 0 },
      { ...earn, userId: -1001 },
      { ...earn, userId: 1001.5 },
      { ...earn, userId: Number.MAX_SAFE_INTEGER + 1 },
      { ...earn, userId: null },
      [earn],
    ];
    for (const payload of refused) {
      const response = await post(payload);
      expect({ payload, status: response.statusCode, error: response.json<{ error: string }>().error }).toEqual({ payload, status: 400, error: 'invalid_request' });
    }
    expect(calls).toEqual([]);
  });

  test('the edges of the earn range are accepted', async () => {
    expect((await post({ ...earn, amount: 1 })).statusCode).toBe(201);
    expect((await post({ ...earn, amount: 1000 })).statusCode).toBe(201);
    expect((await post({ ...earn, userId: Number.MAX_SAFE_INTEGER })).statusCode).toBe(201);
  });

  test('no token is 401 with a Bearer challenge, and a token without game:economy is 403', async () => {
    const anonymous = await app.inject({ method: 'POST', url: '/v1/economy/transactions', headers: { 'idempotency-key': 'job-1:1001:1' }, payload: earn });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers['www-authenticate']).toBe('Bearer');
    expect(anonymous.json()).toMatchObject({ error: 'unauthorized' });

    const memory = await createMemoryAppDeps();
    const scoped = await buildApp({ ...memory.deps, ledger: recordingLedger().ledger });
    const telemetryOnly = bearer(await gameToken(memory.deps.tokens, ['game:telemetry']));
    const forbidden = await scoped.inject({
      method: 'POST',
      url: '/v1/economy/transactions',
      headers: { ...telemetryOnly, 'idempotency-key': 'job-1:1001:1' },
      payload: earn,
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ error: 'insufficient_scope' });
    expect(calls).toEqual([]);
  });
});

describe('fulfilled and unfulfilled purchase routes', () => {
  test('fulfilled validates the id and passes the caller principal to the ledger', async () => {
    const id = randomUUID();
    const fulfilled = await app.inject({ method: 'POST', url: `/v1/economy/transactions/${id}/fulfilled`, headers });
    expect({ status: fulfilled.statusCode, body: fulfilled.body, type: fulfilled.headers['content-type'] }).toEqual({ status: 204, body: '', type: undefined });
    expect(calls).toEqual([{ fulfilled: id, principal: 'svc:game-server' }]);
    const bad = await app.inject({ method: 'POST', url: '/v1/economy/transactions/not-a-uuid/fulfilled', headers });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'invalid_request' });
    expect(calls).toHaveLength(1);
  });

  test('the unfulfilled list needs unfulfilled=1 and a valid userId', async () => {
    const list = await app.inject({ method: 'GET', url: '/v1/players/1001/purchases?unfulfilled=1', headers });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ purchases: [] });
    for (const url of [
      '/v1/players/1001/purchases',
      '/v1/players/1001/purchases?unfulfilled=0',
      '/v1/players/1001/purchases?unfulfilled=1&extra=1',
      '/v1/players/0/purchases?unfulfilled=1',
      '/v1/players/1e3/purchases?unfulfilled=1',
    ]) {
      const response = await app.inject({ method: 'GET', url, headers });
      expect({ url, status: response.statusCode, error: response.json<{ error: string }>().error }).toEqual({ url, status: 400, error: 'invalid_request' });
    }
  });
});

describe('memory deps without a ledger override', () => {
  test('the default ledger answers 503 ledger_unavailable, since the ledger needs MySQL', async () => {
    const memory = await createMemoryAppDeps();
    const plain = await buildApp(memory.deps);
    const auth = bearer(await gameToken(memory.deps.tokens));
    const response = await plain.inject({ method: 'POST', url: '/v1/economy/transactions', headers: { ...auth, 'idempotency-key': 'job-1:1001:1' }, payload: earn });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'ledger_unavailable' });
    const list = await plain.inject({ method: 'GET', url: '/v1/players/1001/purchases?unfulfilled=1', headers: auth });
    expect(list.statusCode).toBe(503);
    expect(list.json()).toMatchObject({ error: 'ledger_unavailable' });
  });
});
