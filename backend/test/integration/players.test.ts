import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { AppDeps } from '../../src/app.js';
import { FAST_ARGON2, createArgon2Hasher, makeDummyHash } from '../../src/modules/identity/crypto/password.js';
import { createMysqlServiceClientRepo } from '../../src/modules/identity/repos/serviceClientRepo.js';
import { limiterKey } from '../../src/modules/identity/guards.js';
import { GAME_SCOPES } from '../../src/modules/identity/scopes.js';
import { GAME_CLIENT_ID } from '../../src/modules/identity/seed.js';
import { createMysqlPlayersService } from '../../src/modules/players/playersService.js';
import { systemClock } from '../../src/platform/clock.js';
import type { RowDataPacket } from '../../src/platform/db.js';
import type { ZodApp } from '../../src/platform/http.js';
import { bearer, gameToken } from '../support/tokens.js';
import { createIntegrationApp } from './support/app.js';
import { createIntegrationContext } from './support/context.js';
import type { IntegrationContext } from './support/context.js';

describe('players on MySQL', () => {
  let ctx: IntegrationContext;
  let app: ZodApp;
  let headers: { authorization: string };
  let tokens: AppDeps['tokens'];
  let apiLimiter: AppDeps['apiLimiter'];
  beforeAll(async () => {
    ctx = await createIntegrationContext();
    const built = await createIntegrationApp(ctx);
    app = built.app;
    tokens = built.deps.tokens;
    apiLimiter = built.deps.apiLimiter;
    // MySQL starts with no service clients, so register the game server before signing its token.
    const hasher = createArgon2Hasher(FAST_ARGON2);
    await createMysqlServiceClientRepo(ctx.db, systemClock).upsert({
      clientId: GAME_CLIENT_ID,
      secretHash: await makeDummyHash(hasher),
      scopes: GAME_SCOPES,
    });
    headers = bearer(await gameToken(built.deps.tokens));
  });
  afterAll(async () => {
    await app.close();
    await ctx.close();
  });

  const count = async (sql: string, params: unknown[] = []) => {
    const [rows] = await ctx.db.query<RowDataPacket[]>(sql, params);
    return Number(rows[0]?.n);
  };

  // Every test here shares one app, so one per-client API bucket (API_LIMIT, 100 then 50 a second).
  // A burst test starts from a full bucket, otherwise on a fast runner the requests of the earlier
  // tests have not refilled yet and some joins are 429 rate_limited, which is not what it checks.
  const fullBucket = () => apiLimiter.forget(limiterKey(GAME_CLIENT_ID));
  const statuses = (responses: { statusCode: number }[]) => {
    const histogram: Record<number, number> = {};
    for (const r of responses) histogram[r.statusCode] = (histogram[r.statusCode] ?? 0) + 1;
    return histogram;
  };
  const otherBodies = (responses: { statusCode: number; body: string }[]) =>
    [...new Set(responses.filter((r) => r.statusCode !== 200).map((r) => r.body))].join('; ');

  // Review Focus 2: ids above 2^32 and up to 2^53 - 1 round-trip exactly.
  test('big UserIds survive MySQL BIGINT and JSON unchanged', async () => {
    for (const userId of [4_294_967_296, Number.MAX_SAFE_INTEGER]) {
      const joined = await app.inject({ method: 'POST', url: `/v1/players/${userId}/sessions`, headers });
      expect(joined.json()).toEqual({ userId, balance: 0 });
      const [rows] = await ctx.db.query<RowDataPacket[]>('SELECT CAST(roblox_user_id AS CHAR) AS id FROM players WHERE roblox_user_id = ?', [
        String(userId),
      ]);
      expect(rows[0]?.id).toBe(String(userId));
      const wallet = await app.inject({ method: 'GET', url: `/v1/players/${userId}/wallet`, headers });
      expect(wallet.json()).toEqual({ userId, balance: 0 });
    }
  });

  test('joining twice keeps one wallet, leaving stamps last_left_at', async () => {
    await app.inject({ method: 'POST', url: '/v1/players/1001/sessions', headers });
    await app.inject({ method: 'POST', url: '/v1/players/1001/sessions', headers });
    expect(await count("SELECT COUNT(*) AS n FROM accounts WHERE account_id = 'player:1001'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM account_balances WHERE account_id = 'player:1001'")).toBe(1);
    expect((await app.inject({ method: 'POST', url: '/v1/players/1001/sessions/end', headers })).statusCode).toBe(204);
    const [players] = await ctx.db.query<RowDataPacket[]>('SELECT last_left_at FROM players WHERE roblox_user_id = 1001');
    expect(players[0]?.last_left_at).toBeInstanceOf(Date);
  });

  // S3-F11: the status-only version of this test let "update first_seen on every join" survive.
  test('first_seen_at is set by the first join and never moved by later joins', async () => {
    let now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const players = createMysqlPlayersService(ctx.db, { now: () => now });
    await players.join(5005);
    now += 60_000;
    await players.join(5005);
    const [rows] = await ctx.db.query<RowDataPacket[]>('SELECT first_seen_at, last_seen_at FROM players WHERE roblox_user_id = 5005');
    expect((rows[0]?.first_seen_at as Date).getTime()).toBe(Date.UTC(2026, 0, 1, 12, 0, 0));
    expect((rows[0]?.last_seen_at as Date).getTime()).toBe(Date.UTC(2026, 0, 1, 12, 1, 0));
  });

  // S3-F3: the ledger holds the balance row FOR UPDATE and then needs a shared lock on the players
  // row (fk_ledger_player). A rejoin that held the players row and then waited on the balance row
  // closed that cycle into a deadlock, so a rejoin must not lock the accounts or balance rows.
  test('a rejoin does not wait on locks held on the account or balance row', async () => {
    const players = createMysqlPlayersService(ctx.db, systemClock);
    await players.join(6006);
    const holder = await ctx.db.getConnection();
    try {
      await holder.beginTransaction();
      await holder.query("SELECT balance FROM account_balances WHERE account_id = 'player:6006' FOR UPDATE");
      await holder.query("SELECT account_id FROM accounts WHERE account_id = 'player:6006' FOR UPDATE");
      const timedOut = Symbol('timed out');
      let timer: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([
        players.join(6006),
        new Promise<symbol>((resolve) => {
          timer = setTimeout(() => resolve(timedOut), 3_000);
        }),
      ]);
      clearTimeout(timer);
      expect(outcome).toEqual({ userId: 6006, balance: 0 });
    } finally {
      await holder.rollback();
      holder.release();
    }
  });

  test('a wallet for a player who never joined is 404 player_not_found on MySQL', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/players/987654321/wallet', headers });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'player_not_found' });
    const left = await app.inject({ method: 'POST', url: '/v1/players/987654321/sessions/end', headers });
    expect(left.statusCode).toBe(404);
    expect(left.json()).toMatchObject({ error: 'player_not_found' });
  });

  test('concurrent joins for the same UserId all answer 200 and make one player, account and balance', async () => {
    fullBucket();
    const responses = await Promise.all(
      Array.from({ length: 40 }, () => app.inject({ method: 'POST', url: '/v1/players/7007/sessions', headers })),
    );
    expect(statuses(responses), otherBodies(responses)).toEqual({ 200: 40 });
    for (const r of responses) expect(r.json()).toEqual({ userId: 7007, balance: 0 });
    expect(await count('SELECT COUNT(*) AS n FROM players WHERE roblox_user_id = 7007')).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM accounts WHERE roblox_user_id = 7007')).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM account_balances WHERE account_id = 'player:7007'")).toBe(1);
  });

  test('concurrent joins across many players and repeats produce no 500s', async () => {
    const ids = Array.from({ length: 15 }, (_, i) => 8000 + i);
    fullBucket();
    const responses = await Promise.all(
      ids.flatMap((id) => Array.from({ length: 4 }, () => app.inject({ method: 'POST', url: `/v1/players/${id}/sessions`, headers }))),
    );
    expect(statuses(responses), otherBodies(responses)).toEqual({ 200: 60 });
    expect(await count('SELECT COUNT(*) AS n FROM accounts WHERE roblox_user_id BETWEEN 8000 AND 8014')).toBe(15);
  });

  test('a token without game:economy is 403 insufficient_scope and an operator token is 401', async () => {
    const limited = bearer(await gameToken(tokens, ['game:telemetry']));
    const forbidden = await app.inject({ method: 'GET', url: '/v1/players/1001/wallet', headers: limited });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ error: 'insufficient_scope' });
    const operator = bearer(await tokens.signAccessToken({ userId: 'op-1', tokenVersion: 1 }));
    const rejected = await app.inject({ method: 'GET', url: '/v1/players/1001/wallet', headers: operator });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).toMatchObject({ error: 'unauthorized' });
  });

  test('account ids are compared as bytes and balances are BIGINT', async () => {
    const [cols] = await ctx.db.query<RowDataPacket[]>(
      "SELECT table_name AS t, column_name AS c, column_type AS ct, collation_name AS co FROM information_schema.columns WHERE table_schema = DATABASE() AND ((table_name = 'accounts' AND column_name = 'account_id') OR (table_name = 'account_balances' AND column_name IN ('account_id', 'balance')))",
    );
    const byKey = Object.fromEntries(cols.map((r) => [`${String(r.t)}.${String(r.c)}`, r]));
    expect(byKey['accounts.account_id']?.co).toBe('utf8mb4_bin');
    expect(byKey['account_balances.account_id']?.co).toBe('utf8mb4_bin');
    expect(String(byKey['account_balances.balance']?.ct)).toMatch(/^bigint/);
  });
});
