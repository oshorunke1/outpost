import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { MIGRATIONS_DIR, loadMigrations } from '../../../src/platform/migrate.js';

const dirs: string[] = [];
function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'outpost-migrations-'));
  dirs.push(dir);
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('loadMigrations', () => {
  test('sorts by number and fingerprints each file', () => {
    const migrations = loadMigrations(dirWith({ '002_b.sql': 'SELECT 2;', '001_a.sql': 'SELECT 1;' }));
    expect(migrations.map((m) => [m.version, m.name])).toEqual([[1, 'a'], [2, 'b']]);
    expect(migrations[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  test('refuses a gap in the numbering', () => {
    expect(() => loadMigrations(dirWith({ '001_a.sql': '', '003_c.sql': '' }))).toThrow('no gaps');
  });

  test('refuses a badly named file', () => {
    expect(() => loadMigrations(dirWith({ '1_a.sql': '' }))).toThrow('001_name.sql');
  });

  test('the real migrations folder loads', () => {
    expect(loadMigrations(MIGRATIONS_DIR)[0]).toMatchObject({ version: 1, name: 'identity' });
  });

  test('the operators email column is binary collated and unique (S2-F1)', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '001_identity.sql'), 'utf8');
    expect(sql).toMatch(/email VARCHAR\(254\) COLLATE utf8mb4_bin NOT NULL/);
    expect(sql).toMatch(/UNIQUE KEY uq_operators_email \(email\)/);
  });
});
