import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { FAST_ARGON2, createArgon2Hasher } from '../../src/modules/identity/crypto/password.js';
import { createMysqlServiceClientRepo } from '../../src/modules/identity/repos/serviceClientRepo.js';
import { GAME_CLIENT_ID, seedDev } from '../../src/modules/identity/seed.js';
import { systemClock } from '../../src/platform/clock.js';
import type { RowDataPacket } from '../../src/platform/db.js';
import type { ZodApp } from '../../src/platform/http.js';
import { createIntegrationApp } from './support/app.js';
import { createIntegrationContext } from './support/context.js';
import type { IntegrationContext } from './support/context.js';

const KEY_SHAPE = /opk_game-server\.[A-Za-z0-9_-]{43}/g;
const BACKEND_DIR = fileURLToPath(new URL('../..', import.meta.url));
const run = promisify(execFile);

describe('seedDev on MySQL', () => {
  let ctx: IntegrationContext;
  let app: ZodApp;
  beforeAll(async () => {
    ctx = await createIntegrationContext();
    ({ app } = await createIntegrationApp(ctx));
  });
  afterAll(async () => {
    await app.close();
    await ctx.close();
  });
  beforeEach(async () => {
    await ctx.db.query('DELETE FROM service_clients');
    await ctx.redis.flushdb(); // a fresh exchange budget for every test
  });

  const hasher = createArgon2Hasher(FAST_ARGON2);
  const seed = (overrides: { nodeEnv?: string | undefined; rotate?: boolean; operatorPassword?: string } = {}) =>
    seedDev({
      db: ctx.db,
      clock: systemClock,
      hasher,
      nodeEnv: 'nodeEnv' in overrides ? overrides.nodeEnv : 'test',
      ...(overrides.rotate ? { rotate: true } : {}),
      operatorEmail: 'Dev@Outpost.Local',
      operatorPassword: overrides.operatorPassword ?? 'first-pw',
    });
  const exchange = (apiKey: string) =>
    app.inject({ method: 'POST', url: '/auth/service-token', headers: { authorization: `ApiKey ${apiKey}` } });
  const clientRows = async () => {
    const [rows] = await ctx.db.query<RowDataPacket[]>('SELECT client_id, secret_hash FROM service_clients');
    return rows as { client_id: string; secret_hash: string }[];
  };

  test('refuses outside development and test, before touching the database', async () => {
    for (const nodeEnv of ['production', 'staging', undefined, '', 'Development', 'TEST', 'development ']) {
      await expect(seed({ nodeEnv })).rejects.toThrow('only runs when NODE_ENV is development or test');
    }
    expect(await clientRows()).toEqual([]);
  });

  test('a first run makes a random key, stores only its Argon2 hash, and the key buys a token', async () => {
    const result = await seed();
    expect(result).toMatchObject({ clientId: GAME_CLIENT_ID, operatorEmail: 'dev@outpost.local' });
    expect(result.apiKey).toMatch(/^opk_game-server\.[A-Za-z0-9_-]{43}$/);
    const apiKey = result.apiKey ?? '';
    const secret = apiKey.split('.')[1] ?? '';
    const rows = await clientRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.secret_hash).toMatch(/^\$argon2id\$/);
    expect(rows[0]?.secret_hash).not.toContain(secret);

    const response = await exchange(apiKey);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ tokenType: 'Bearer', scope: 'game:economy game:telemetry game:flags.read' });
  });

  test('two runs never share a secret', async () => {
    const first = await seed();
    await ctx.db.query('DELETE FROM service_clients');
    const second = await seed();
    expect(first.apiKey).not.toBeNull();
    expect(second.apiKey).not.toBeNull();
    expect(second.apiKey).not.toBe(first.apiKey);
  });

  test('running it again keeps the key and updates the operator; rotate replaces the key', async () => {
    const first = await seed({ operatorPassword: 'first-pw' });
    await expect(seed({ operatorPassword: 'second-pw' })).resolves.toEqual({
      clientId: GAME_CLIENT_ID,
      apiKey: null,
      operatorEmail: 'dev@outpost.local',
    });
    expect((await exchange(first.apiKey ?? '')).statusCode).toBe(200);
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'dev@outpost.local', password: 'second-pw' } });
    expect(login.statusCode).toBe(200);

    const rotated = await seed({ rotate: true });
    expect(rotated.apiKey).toMatch(/^opk_game-server\.[A-Za-z0-9_-]{43}$/);
    expect(rotated.apiKey).not.toBe(first.apiKey);
    const old = await exchange(first.apiKey ?? '');
    expect(old.statusCode).toBe(401);
    expect(old.json()).toMatchObject({ error: 'invalid_api_key' });
    expect((await exchange(rotated.apiKey ?? '')).statusCode).toBe(200);
  });

  test('a client disabled in MySQL cannot exchange its key', async () => {
    const { apiKey } = await seed();
    await createMysqlServiceClientRepo(ctx.db, systemClock).setDisabled(GAME_CLIENT_ID, true);
    const response = await exchange(apiKey ?? '');
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'invalid_api_key' });
  });

  describe('the seed CLI', () => {
    const cli = async (nodeEnv: string | undefined) => {
      const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: ctx.databaseUrl };
      delete env.NODE_ENV;
      delete env.OUTPOST_DEV_OPERATOR_EMAIL;
      delete env.OUTPOST_DEV_OPERATOR_PASSWORD;
      delete env.OUTPOST_GAME_API_KEY;
      if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
      try {
        const { stdout, stderr } = await run(process.execPath, ['--import', 'tsx', 'src/cli/seed.ts'], { cwd: BACKEND_DIR, env });
        return { code: 0, stdout, stderr };
      } catch (error) {
        const failed = error as { code?: number; stdout?: string; stderr?: string };
        return { code: failed.code ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
      }
    };

    test('exits 1 for production, staging or no NODE_ENV and writes nothing', async () => {
      for (const nodeEnv of ['production', 'staging', undefined]) {
        const result = await cli(nodeEnv);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('only runs when NODE_ENV is development or test');
        expect(result.stdout).not.toMatch(KEY_SHAPE);
      }
      expect(await clientRows()).toEqual([]);
    });

    test('prints the full key exactly once, and the printed key works for an exchange', async () => {
      const result = await cli('test');
      expect(result.code).toBe(0);
      const printed = result.stdout.match(KEY_SHAPE) ?? [];
      expect(printed).toHaveLength(1);
      expect(result.stderr).not.toMatch(KEY_SHAPE);
      const response = await exchange(printed[0] ?? '');
      expect(response.statusCode).toBe(200);

      // A second run leaves the key alone and prints no key at all.
      const again = await cli('development');
      expect(again.code).toBe(0);
      expect(again.stdout).not.toMatch(KEY_SHAPE);
      expect((await exchange(printed[0] ?? '')).statusCode).toBe(200);
    });
  });
});
