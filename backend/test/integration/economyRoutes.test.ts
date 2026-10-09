import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { LedgerService } from '../../src/modules/economy/ledger.js';
import { FAST_ARGON2, createArgon2Hasher, makeDummyHash } from '../../src/modules/identity/crypto/password.js';
import type { TokenService } from '../../src/modules/identity/crypto/tokenService.js';
import { createMysqlServiceClientRepo } from '../../src/modules/identity/repos/serviceClientRepo.js';
import { GAME_SCOPES } from '../../src/modules/identity/scopes.js';
import { GAME_CLIENT_ID } from '../../src/modules/identity/seed.js';
import { systemClock } from '../../src/platform/clock.js';
import type { ZodApp } from '../../src/platform/http.js';
import { bearer, gameToken } from '../support/tokens.js';
import { createIntegrationApp } from './support/app.js';
import { createIntegrationContext } from './support/context.js';
import type { IntegrationContext } from './support/context.js';
import { failingCommitDb, lockWaitTimeoutDb } from './support/failingDb.js';

const OTHER_CLIENT_ID = 'other-client';

describe('economy over HTTP on MySQL', () => {
  let ctx: IntegrationContext;
  let app: ZodApp;
  let tokens: TokenService;
  let ledger: LedgerService;
  let auth: { authorization: string };
  beforeAll(async () => {
    ctx = await createIntegrationContext();
    const built = await createIntegrationApp(ctx);
    app = built.app;
    tokens = built.deps.tokens;
    ledger = built.deps.ledger;
    // MySQL starts with no service clients, so register both before signing their tokens. The
    // second one has game:economy too, but it is a different caller.
    const hasher = createArgon2Hasher(FAST_ARGON2);
    const clients = createMysqlServiceClientRepo(ctx.db, systemClock);
    await clients.upsert({ clientId: GAME_CLIENT_ID, secretHash: await makeDummyHash(hasher), scopes: GAME_SCOPES });
    await clients.upsert({ clientId: OTHER_CLIENT_ID, secretHash: await makeDummyHash(hasher), scopes: GAME_SCOPES });
    auth = bearer(await gameToken(tokens));
  });
  afterAll(async () => {
    await app.close();
    await ctx.close();
  });

  const transact = (key: string, payload: object, on: ZodApp = app, as: { authorization: string } = auth) =>
    on.inject({ method: 'POST', url: '/v1/economy/transactions', headers: { ...as, 'idempotency-key': key }, payload });
  const join = (userId: number) => app.inject({ method: 'POST', url: `/v1/players/${userId}/sessions`, headers: auth });

  test('join, earn, buy, replay, reconcile, acknowledge', async () => {
    await join(1001);
    expect((await transact('job-a:1001:1', { kind: 'earn', userId: 1001, amount: 30, reason: 'orbs' })).statusCode).toBe(201);

    const bought = await transact('buy-key-0001', { kind: 'purchase', userId: 1001, itemId: 'RedHat' });
    expect(bought.statusCode).toBe(201);
    const purchase = bought.json<{ transactionId: string; balanceAfter: number; amount: number }>();
    expect(purchase).toMatchObject({ amount: -25, balanceAfter: 5 });

    const replay = await transact('buy-key-0001', { kind: 'purchase', userId: 1001, itemId: 'RedHat' });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ transactionId: purchase.transactionId, replayed: true });

    const poor = await transact('buy-key-0002', { kind: 'purchase', userId: 1001, itemId: 'GoldCrown' });
    expect(poor.statusCode).toBe(422);
    expect(poor.json()).toMatchObject({ error: 'insufficient_funds' });

    const pending = await app.inject({ method: 'GET', url: '/v1/players/1001/purchases?unfulfilled=1', headers: auth });
    expect(pending.json()).toMatchObject({ purchases: [{ transactionId: purchase.transactionId, itemId: 'RedHat' }] });
    const ack = await app.inject({ method: 'POST', url: `/v1/economy/transactions/${purchase.transactionId}/fulfilled`, headers: auth });
    expect(ack.statusCode).toBe(204);
    const again = await app.inject({ method: 'POST', url: `/v1/economy/transactions/${purchase.transactionId}/fulfilled`, headers: auth });
    expect(again.statusCode).toBe(204); // a repeat acknowledgement is harmless
    expect((await app.inject({ method: 'GET', url: '/v1/players/1001/purchases?unfulfilled=1', headers: auth })).json()).toEqual({ purchases: [] });
    expect((await app.inject({ method: 'GET', url: '/v1/players/1001/wallet', headers: auth })).json()).toEqual({ userId: 1001, balance: 5 });
  });

  // MySQL JSON hands the stored result back with its keys reordered. The response schema puts
  // them back in a fixed order, so only the replayed flag differs.
  test('a replayed body is byte for byte the first one apart from replayed, for earns and purchases', async () => {
    await join(1002);
    const cases: [string, object][] = [
      ['bytes-earn-1', { kind: 'earn', userId: 1002, amount: 40, reason: 'orbs' }],
      ['bytes-buy-01', { kind: 'purchase', userId: 1002, itemId: 'RedHat' }],
    ];
    for (const [key, payload] of cases) {
      const first = await transact(key, payload);
      expect(first.statusCode).toBe(201);
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      const second = await transact(key, payload);
      expect(second.statusCode).toBe(200);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(first.body).toContain('"replayed":false');
      expect(second.body).toBe(first.body.replace('"replayed":false', '"replayed":true'));
    }
  });

  test('a key reused for a different body is 409 idempotency_key_reuse', async () => {
    await join(1003);
    expect((await transact('reuse-key-1', { kind: 'earn', userId: 1003, amount: 5, reason: 'orbs' })).statusCode).toBe(201);
    const reused = await transact('reuse-key-1', { kind: 'earn', userId: 1003, amount: 6, reason: 'orbs' });
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ error: 'idempotency_key_reuse' });
  });

  test('a player who never joined is 404 player_not_found', async () => {
    const response = await transact('never-joined-1', { kind: 'earn', userId: 999_999, amount: 5, reason: 'orbs' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'player_not_found' });
  });

  test('another game:economy client cannot acknowledge a purchase it did not make, and learns nothing from trying', async () => {
    await join(1004);
    await transact('other-earn-1', { kind: 'earn', userId: 1004, amount: 25, reason: 'orbs' });
    const bought = await transact('other-buy-01', { kind: 'purchase', userId: 1004, itemId: 'RedHat' });
    const id = bought.json<{ transactionId: string }>().transactionId;

    const other = bearer(await tokens.signServiceToken({ clientId: OTHER_CLIENT_ID, scopes: GAME_SCOPES }));
    const foreign = await app.inject({ method: 'POST', url: `/v1/economy/transactions/${id}/fulfilled`, headers: other });
    const missing = await app.inject({ method: 'POST', url: '/v1/economy/transactions/00000000-0000-4000-8000-000000000000/fulfilled', headers: other });
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(foreign.json()).toEqual(missing.json());
    expect(foreign.json()).toMatchObject({ error: 'purchase_not_found' });

    const pending = await app.inject({ method: 'GET', url: '/v1/players/1004/purchases?unfulfilled=1', headers: auth });
    expect(pending.json()).toMatchObject({ purchases: [{ transactionId: id }] });
    expect((await app.inject({ method: 'POST', url: `/v1/economy/transactions/${id}/fulfilled`, headers: auth })).statusCode).toBe(204);
  });

  test('only purchases can be fulfilled: an earn id and a refund id are both 404 purchase_not_found', async () => {
    await join(1007);
    const earned = await transact('fulfil-earn-1', { kind: 'earn', userId: 1007, amount: 25, reason: 'orbs' });
    const bought = await transact('fulfil-buy-01', { kind: 'purchase', userId: 1007, itemId: 'RedHat' });
    // Refunds have no route yet, so this one goes straight through the composed ledger.
    const refunded = await ledger.refund({ principal: `svc:${GAME_CLIENT_ID}`, idempotencyKey: 'fulfil-refund-1', transactionId: bought.json<{ transactionId: string }>().transactionId });
    for (const id of [earned.json<{ transactionId: string }>().transactionId, refunded.result.transactionId]) {
      const response = await app.inject({ method: 'POST', url: `/v1/economy/transactions/${id}/fulfilled`, headers: auth });
      expect({ id, status: response.statusCode, error: response.json<{ error: string }>().error }).toEqual({ id, status: 404, error: 'purchase_not_found' });
    }
  });

  test('a lost COMMIT is 503 ledger_unavailable with retry-after, and the composition root logs it', async () => {
    await join(1005);
    const logged: string[] = [];
    const logger = { error: (_details: object, message: string) => void logged.push(message), warn: () => undefined };
    const flaky = await createIntegrationApp(ctx, { db: failingCommitDb(ctx.db, 'before-apply'), logger });
    try {
      const response = await transact('lost-commit-1', { kind: 'earn', userId: 1005, amount: 7, reason: 'orbs' }, flaky.app, bearer(await gameToken(flaky.deps.tokens)));
      expect(response.statusCode).toBe(503);
      expect(response.headers['retry-after']).toBe('1');
      expect(response.json()).toMatchObject({ error: 'ledger_unavailable' });
      expect(logged).toEqual(['transaction commit failed; its outcome is unknown']);
    } finally {
      await flaky.app.close();
    }
    // The same key on a healthy app settles it: the first try never landed.
    expect((await transact('lost-commit-1', { kind: 'earn', userId: 1005, amount: 7, reason: 'orbs' })).statusCode).toBe(201);
  });

  test('lock wait timeouts on every attempt are 503 ledger_unavailable with retry-after', async () => {
    await join(1006);
    const stuck = lockWaitTimeoutDb(ctx.db);
    const busy = await createIntegrationApp(ctx, { db: stuck.db });
    try {
      const response = await transact('lock-wait-01', { kind: 'earn', userId: 1006, amount: 7, reason: 'orbs' }, busy.app, bearer(await gameToken(busy.deps.tokens)));
      expect(response.statusCode).toBe(503);
      expect(response.headers['retry-after']).toBe('1');
      expect(response.json()).toMatchObject({ error: 'ledger_unavailable' });
      expect(stuck.attempts()).toBe(3);
    } finally {
      await busy.app.close();
    }
  });
});
