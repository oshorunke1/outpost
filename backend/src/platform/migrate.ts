import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db, RowDataPacket } from './db.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

// backend/migrations, from both src/platform and dist/platform.
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

const FILE_PATTERN = /^(\d{3})_([a-z0-9_]+)\.sql$/;

export function loadMigrations(dir: string): Migration[] {
  const migrations = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .map((file) => {
      const match = FILE_PATTERN.exec(file);
      if (!match?.[1] || !match[2]) throw new Error(`migration file ${file} must look like 001_name.sql`);
      const sql = readFileSync(join(dir, file), 'utf8');
      return { version: Number(match[1]), name: match[2], sql, checksum: createHash('sha256').update(sql).digest('hex') };
    })
    .sort((a, b) => a.version - b.version);
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(`migrations must be numbered 1..n with no gaps, found ${migration.version} at position ${index + 1}`);
    }
  });
  return migrations;
}

// Applies every migration not yet recorded, in order, under a MySQL named lock so two runners
// never race. MySQL DDL commits on its own, so a failed migration can leave half its statements
// applied; migrations are written to be small for that reason.
export async function migrate(db: Db, migrations: readonly Migration[]): Promise<number[]> {
  const conn = await db.getConnection();
  try {
    const [lock] = await conn.query<RowDataPacket[]>("SELECT GET_LOCK('outpost_migrate', 30) AS got");
    if (lock[0]?.got !== 1) throw new Error('could not take the migration lock');
    try {
      await conn.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations (version INT UNSIGNED NOT NULL PRIMARY KEY, name VARCHAR(100) NOT NULL, checksum CHAR(64) NOT NULL, applied_at DATETIME(3) NOT NULL)',
      );
      const [rows] = await conn.query<RowDataPacket[]>('SELECT version, checksum FROM schema_migrations');
      const applied = new Map(rows.map((row) => [Number(row.version), String(row.checksum)]));
      const ran: number[] = [];
      for (const migration of migrations) {
        const known = applied.get(migration.version);
        if (known !== undefined) {
          if (known !== migration.checksum) {
            throw new Error(`migration ${migration.version}_${migration.name} was edited after it was applied`);
          }
          continue;
        }
        await conn.query(migration.sql);
        await conn.query('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, UTC_TIMESTAMP(3))', [
          migration.version,
          migration.name,
          migration.checksum,
        ]);
        ran.push(migration.version);
      }
      return ran;
    } finally {
      // MySQL drops the lock when the connection closes, so a failed release must not hide the
      // real migration error.
      await conn.query("SELECT RELEASE_LOCK('outpost_migrate')").catch(() => undefined);
    }
  } finally {
    conn.release();
  }
}
