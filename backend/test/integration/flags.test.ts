import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { FLAG_DEFAULTS, createMysqlFlagsService } from '../../src/modules/flags/flagsService.js';
import type { FlagsLogger } from '../../src/modules/flags/flagsService.js';
import { FAST_ARGON2, createArgon2Hasher, makeDummyHash } from '../../src/modules/identity/crypto/password.js';
import { createMysqlServiceClientRepo } from '../../src/modules/identity/repos/serviceClientRepo.js';
import { GAME_SCOPES } from '../../src/modules/identity/scopes.js';
import { GAME_CLIENT_ID } from '../../src/modules/identity/seed.js';
import { systemClock } from '../../src/platform/clock.js';
import type { Db, RowDataPacket } from '../../src/platform/db.js';
import { createFakeClock } from '../support/clock.js';
import { bearer, gameToken } from '../support/tokens.js';
import { createIntegrationApp } from './support/app.js';
import { createIntegrationContext } from './support/context.js';
import type { IntegrationContext } from './support/context.js';

// A pool whose plain queries can be switched to fail, like MySQL going away and coming back.
function switchableDb(db: Db): { db: Db; setDown(down: boolean): void } {
  let down = false;
  const wrapped = new Proxy(db, {
    get(target, prop) {
      if (prop === 'query' && down) return () => Promise.reject(new Error('connect ECONNREFUSED'));
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return {
    db: wrapped,
    setDown(value) {
      down = value;
    },
  };
}

function recordingLogger(): FlagsLogger & { lines: { details: object; message: string }[] } {
  const lines: { details: object; message: string }[] = [];
  return {
    lines,
    warn(details, message) {
      lines.push({ details, message });
    },
  };
}

const SEED_ROWS = `INSERT INTO flags (flag_key, flag_value, critical, description, updated_at) VALUES
  ('ShopEnabled', CAST('true' AS JSON), TRUE, 'Turns the shop on or off on every server', UTC_TIMESTAMP(3)),
  ('OrbSpawnMultiplier', CAST('1' AS JSON), FALSE, 'Scales how many orbs spawn', UTC_TIMESTAMP(3)),
  ('TelemetryEnabled', CAST('true' AS JSON), FALSE, 'Lets game servers send telemetry batches', UTC_TIMESTAMP(3))`;

describe('flags on MySQL', () => {
  let ctx: IntegrationContext;
  beforeAll(async () => {
    ctx = await createIntegrationContext();
  });
  afterAll(async () => {
    await ctx.close();
  });

  // Every test after the first starts from the seeded rows, so test order never matters.
  beforeEach(async (context) => {
    if (context.task.name.startsWith('the migration')) return;
    await ctx.db.query('DELETE FROM flags');
    await ctx.db.query(SEED_ROWS);
  });

  test('the migration seeds exactly the defaults, with their JSON types', async () => {
    const [rows] = await ctx.db.query<RowDataPacket[]>('SELECT flag_key, JSON_TYPE(flag_value) AS kind FROM flags ORDER BY flag_key');
    expect(rows.map((row) => [String(row.flag_key), String(row.kind)])).toEqual([
      ['OrbSpawnMultiplier', 'INTEGER'],
      ['ShopEnabled', 'BOOLEAN'],
      ['TelemetryEnabled', 'BOOLEAN'],
    ]);
    await expect(createMysqlFlagsService(ctx.db, createFakeClock(), { logger: recordingLogger() }).list()).resolves.toEqual(FLAG_DEFAULTS);
  });

  test('values are cached for five seconds', async () => {
    const clock = createFakeClock();
    const flags = createMysqlFlagsService(ctx.db, clock, { logger: recordingLogger() });
    await flags.list();
    await ctx.db.query("UPDATE flags SET flag_value = CAST('false' AS JSON) WHERE flag_key = 'ShopEnabled'");
    await expect(flags.list()).resolves.toMatchObject({ ShopEnabled: true });
    clock.advance(4_999);
    await expect(flags.list()).resolves.toMatchObject({ ShopEnabled: true });
    clock.advance(2);
    await expect(flags.list()).resolves.toMatchObject({ ShopEnabled: false });
  });

  test('a string value is served as stored', async () => {
    await ctx.db.query(
      `INSERT INTO flags (flag_key, flag_value, critical, description, updated_at) VALUES ('Motd', CAST('"hello"' AS JSON), FALSE, 'A message', UTC_TIMESTAMP(3))`,
    );
    const flags = createMysqlFlagsService(ctx.db, createFakeClock(), { logger: recordingLogger() });
    await expect(flags.list()).resolves.toEqual({ ...FLAG_DEFAULTS, Motd: 'hello' });
  });

  test('a deleted row falls back to its default', async () => {
    await ctx.db.query("UPDATE flags SET flag_value = CAST('3' AS JSON) WHERE flag_key = 'OrbSpawnMultiplier'");
    await ctx.db.query("UPDATE flags SET flag_value = CAST('false' AS JSON) WHERE flag_key = 'TelemetryEnabled'");
    await ctx.db.query("DELETE FROM flags WHERE flag_key = 'ShopEnabled'");
    const flags = createMysqlFlagsService(ctx.db, createFakeClock(), { logger: recordingLogger() });
    await expect(flags.list()).resolves.toEqual({ ShopEnabled: true, OrbSpawnMultiplier: 3, TelemetryEnabled: false });
  });

  test('a null, object or array value is ignored and logged, and the default stands', async () => {
    await ctx.db.query("UPDATE flags SET flag_value = CAST('null' AS JSON) WHERE flag_key = 'ShopEnabled'");
    await ctx.db.query(`UPDATE flags SET flag_value = CAST('{"on":false}' AS JSON) WHERE flag_key = 'TelemetryEnabled'`);
    await ctx.db.query("UPDATE flags SET flag_value = CAST('[2]' AS JSON) WHERE flag_key = 'OrbSpawnMultiplier'");
    const logger = recordingLogger();
    const flags = createMysqlFlagsService(ctx.db, createFakeClock(), { logger });
    await expect(flags.list()).resolves.toEqual(FLAG_DEFAULTS);
    expect(logger.lines).toEqual([
      { details: { flagKey: 'OrbSpawnMultiplier', valueType: 'array' }, message: 'flag value is not a boolean, number or string; using the default' },
      { details: { flagKey: 'ShopEnabled', valueType: 'null' }, message: 'flag value is not a boolean, number or string; using the default' },
      { details: { flagKey: 'TelemetryEnabled', valueType: 'object' }, message: 'flag value is not a boolean, number or string; using the default' },
    ]);
  });

  test('after the cache expires a failing store serves the last good values, logged', async () => {
    const clock = createFakeClock();
    const store = switchableDb(ctx.db);
    const logger = recordingLogger();
    const flags = createMysqlFlagsService(store.db, clock, { logger });
    await ctx.db.query("UPDATE flags SET flag_value = CAST('false' AS JSON) WHERE flag_key = 'ShopEnabled'");
    await expect(flags.list()).resolves.toMatchObject({ ShopEnabled: false });

    store.setDown(true);
    clock.advance(60_000);
    await expect(flags.list()).resolves.toEqual({ ...FLAG_DEFAULTS, ShopEnabled: false });
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]?.message).toBe('flag reload failed; serving the last good values');
    expect(logger.lines[0]?.details).toMatchObject({ cause: { message: 'connect ECONNREFUSED' } });

    // A failed reload waits a full cache period before the next try, so an outage is not hammered.
    clock.advance(4_999);
    await expect(flags.list()).resolves.toEqual({ ...FLAG_DEFAULTS, ShopEnabled: false });
    expect(logger.lines).toHaveLength(1);

    // Once the store is back, the next try picks up changes again.
    store.setDown(false);
    await ctx.db.query("UPDATE flags SET flag_value = CAST('true' AS JSON) WHERE flag_key = 'ShopEnabled'");
    clock.advance(2);
    await expect(flags.list()).resolves.toEqual(FLAG_DEFAULTS);
  });

  test('a cold cache and a failing store rejects with 503 flags_unavailable', async () => {
    const store = switchableDb(ctx.db);
    store.setDown(true);
    const logger = recordingLogger();
    const flags = createMysqlFlagsService(store.db, createFakeClock(), { logger });
    await expect(flags.list()).rejects.toMatchObject({ statusCode: 503, code: 'flags_unavailable', headers: { 'retry-after': '1' } });
    expect(logger.lines).toEqual([]); // the error handler logs a 5xx with its cause
  });

  test('the composed app serves flags from MySQL', async () => {
    const hasher = createArgon2Hasher(FAST_ARGON2);
    await createMysqlServiceClientRepo(ctx.db, systemClock).upsert({ clientId: GAME_CLIENT_ID, secretHash: await makeDummyHash(hasher), scopes: GAME_SCOPES });
    await ctx.db.query("UPDATE flags SET flag_value = CAST('false' AS JSON) WHERE flag_key = 'TelemetryEnabled'");
    const { app, deps } = await createIntegrationApp(ctx);
    try {
      const auth = bearer(await gameToken(deps.tokens));
      const flags = await app.inject({ method: 'GET', url: '/v1/flags', headers: auth });
      expect(flags.statusCode).toBe(200);
      expect(flags.json()).toEqual({ flags: { ...FLAG_DEFAULTS, TelemetryEnabled: false } });

    } finally {
      await app.close();
    }
  });
});
