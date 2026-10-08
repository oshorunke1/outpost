import { randomBytes } from 'node:crypto';
import { createPool, pingDb } from '../../../src/platform/db.js';
import type { Db } from '../../../src/platform/db.js';
import { MIGRATIONS_DIR, loadMigrations, migrate } from '../../../src/platform/migrate.js';
import { connectRedis } from '../../../src/platform/redis.js';
import type { Redis } from '../../../src/platform/redis.js';
import { assertTestRedisDb } from './guard.js';

export interface IntegrationContext {
  db: Db;
  redis: Redis;
  databaseName: string;
  databaseUrl: string;
  close(): Promise<void>;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Run pnpm setup:dev and docker compose up -d mysql redis (see backend/README.md).`);
  }
  return value;
}

// Every test file gets its own freshly migrated database, so files never see each other's rows.
export async function createIntegrationContext(): Promise<IntegrationContext> {
  const serverUrl = requireEnv('TEST_MYSQL_URL').replace(/\/$/, '');
  const databaseName = `outpost_it_${randomBytes(6).toString('hex')}`;
  const admin = createPool(serverUrl, { connectionLimit: 1 });
  await pingDb(admin);
  await admin.query('CREATE DATABASE ??', [databaseName]);
  await admin.end();

  const databaseUrl = `${serverUrl}/${databaseName}`;
  const migrator = createPool(databaseUrl, { multipleStatements: true, connectionLimit: 1 });
  await migrate(migrator, loadMigrations(MIGRATIONS_DIR));
  await migrator.end();

  const db = createPool(databaseUrl, { connectionLimit: 20 });
  const redis = await connectRedis(requireEnv('TEST_REDIS_URL'));
  try {
    assertTestRedisDb(redis); // never flush anything but the test database
  } catch (error) {
    redis.disconnect();
    await db.end();
    throw error;
  }
  await redis.flushdb();

  return {
    db,
    redis,
    databaseName,
    databaseUrl,
    async close() {
      await db.end();
      redis.disconnect();
      const cleanup = createPool(serverUrl, { connectionLimit: 1 });
      await cleanup.query('DROP DATABASE IF EXISTS ??', [databaseName]);
      await cleanup.end();
    },
  };
}
