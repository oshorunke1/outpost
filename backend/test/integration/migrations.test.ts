import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createPool, isDuplicateKey } from '../../src/platform/db.js';
import type { RowDataPacket } from '../../src/platform/db.js';
import { MIGRATIONS_DIR, loadMigrations, migrate } from '../../src/platform/migrate.js';
import { createIntegrationContext } from './support/context.js';
import type { IntegrationContext } from './support/context.js';

describe('migrations on MySQL', () => {
  let ctx: IntegrationContext;
  beforeAll(async () => {
    ctx = await createIntegrationContext();
  });
  afterAll(async () => {
    await ctx.close();
  });

  test('every migration is recorded once', async () => {
    const [rows] = await ctx.db.query<RowDataPacket[]>('SELECT version FROM schema_migrations ORDER BY version');
    expect(rows.map((row) => Number(row.version))).toEqual(loadMigrations(MIGRATIONS_DIR).map((m) => m.version));
  });

  test('running again applies nothing', async () => {
    const migrator = createPool(ctx.databaseUrl, { multipleStatements: true, connectionLimit: 1 });
    try {
      await expect(migrate(migrator, loadMigrations(MIGRATIONS_DIR))).resolves.toEqual([]);
    } finally {
      await migrator.end();
    }
  });

  test('an edited migration is refused', async () => {
    const edited = loadMigrations(MIGRATIONS_DIR).map((m, index) => (index === 0 ? { ...m, checksum: 'f'.repeat(64) } : m));
    const migrator = createPool(ctx.databaseUrl, { multipleStatements: true, connectionLimit: 1 });
    try {
      await expect(migrate(migrator, edited)).rejects.toThrow('migration 1_identity was edited after it was applied');
    } finally {
      await migrator.end();
    }
  });

  test('the operators email index is case sensitive on the stored bytes (S2-F1)', async () => {
    const insert = (id: string, email: string) =>
      ctx.db.query(
        "INSERT INTO operators (operator_id, email, password_hash, scopes, created_at) VALUES (?, ?, 'h', '[]', UTC_TIMESTAMP(3))",
        [id, email],
      );
    await insert('00000000-0000-0000-0000-000000000001', 'a@x.test');
    // The same bytes collide on the unique index.
    const duplicate = await insert('00000000-0000-0000-0000-000000000002', 'a@x.test').catch((e: unknown) => e);
    expect(isDuplicateKey(duplicate)).toBe(true);
    // A different case does not, which is why the app normalizes before it ever gets here.
    await expect(insert('00000000-0000-0000-0000-000000000003', 'A@x.test')).resolves.toBeDefined();
  });
});
