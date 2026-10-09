import { randomBytes } from 'node:crypto';
import { createPool, pingDb } from '../../../src/platform/db.js';
import type { Db } from '../../../src/platform/db.js';
import { MIGRATIONS_DIR, loadMigrations, migrate } from '../../../src/platform/migrate.js';
import { connectRedis } from '../../../src/platform/redis.js';
import type { Redis } from '../../../src/platform/redis.js';
import { assertSafeTestUrls, assertTestRedisDb } from './guard.js';

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

async function dropDatabase(serverUrl: string, databaseName: string): Promise<void> {
  const cleanup = createPool(serverUrl, { connectionLimit: 1 });
  try {
    await cleanup.query('DROP DATABASE IF EXISTS ??', [databaseName]);
  } finally {
    await cleanup.end();
  }
}

// Every test file gets its own freshly migrated database, so files never see each other's rows.
export async function createIntegrationContext(): Promise<IntegrationContext> {
  const mysqlUrl = requireEnv('TEST_MYSQL_URL');
  const redisUrl = requireEnv('TEST_REDIS_URL');
  assertSafeTestUrls(mysqlUrl, redisUrl);
  const serverUrl = mysqlUrl.replace(/\/$/, '');

  // Redis first, so a bad Redis setup fails before any database exists.
  const redis = await connectRedis(redisUrl);
  try {
    assertTestRedisDb(redis); // never flush anything but the test database
  } catch (error) {
    redis.disconnect();
    throw error;
  }

  const databaseName = `outpost_it_${randomBytes(6).toString('hex')}`;
  const databaseUrl = `${serverUrl}/${databaseName}`;
  let db: Db | undefined;
  let created = false;
  try {
    const admin = createPool(serverUrl, { connectionLimit: 1 });
    try {
      await pingDb(admin);
      await admin.query('CREATE DATABASE ??', [databaseName]);
      created = true;
    } finally {
      await admin.end();
    }

    const migrator = createPool(databaseUrl, { multipleStatements: true, connectionLimit: 1 });
    try {
      await migrate(migrator, loadMigrations(MIGRATIONS_DIR));
    } finally {
      await migrator.end();
    }

    db = createPool(databaseUrl, { connectionLimit: 20 });
    await redis.flushdb();
  } catch (error) {
    // Anything that went wrong after the database existed must not leave it behind.
    redis.disconnect();
    await db?.end().catch(() => undefined);
    if (created) await dropDatabase(serverUrl, databaseName).catch(() => undefined);
    throw error;
  }

  const ready = db;
  return {
    db: ready,
    redis,
    databaseName,
    databaseUrl,
    async close() {
      await ready.end();
      redis.disconnect();
      await dropDatabase(serverUrl, databaseName);
    },
  };
}
