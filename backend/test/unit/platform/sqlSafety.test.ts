import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

// A best effort lint, not a proof. It catches the usual ways SQL gets built from strings at a
// query or execute call site. SQL glued together across functions or files can still slip past,
// so code review stays the real guard.

const SRC = fileURLToPath(new URL('../../../src', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

// The start of a query or execute call, with an optional type argument and an optional `{ sql:` object form.
const CALL = String.raw`\.(?:query|execute)(?:<[^>]*>)?\(\s*(?:\{\s*sql\s*:\s*)?`;
// A template literal with ${...} in it, so SQL built from strings.
const TEMPLATE_WITH_VALUE = String.raw`\`[^\`]*\$\{`;
const STRING_BUILT_SQL = new RegExp(CALL + TEMPLATE_WITH_VALUE);
// const or let name = `...${...}`, with an optional type annotation.
const TEMPLATE_VARIABLE = new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*` + TEMPLATE_WITH_VALUE, 'g');

// Returns why the source fails the check, or an empty list when it passes.
function findStringBuiltSql(source: string): string[] {
  const problems: string[] = [];
  if (STRING_BUILT_SQL.test(source)) problems.push('a query or execute call takes a template literal with ${...}');
  for (const match of source.matchAll(TEMPLATE_VARIABLE)) {
    const name = match[1] ?? '';
    // The variable passed straight in, as { sql: name }, or as the { sql } shorthand when it is called sql.
    // $ is the only identifier character that means something in a regex, so it is escaped. The
    // lookahead stops a longer name that merely starts with this one (a $ counts as part of a name).
    const passed = new RegExp(CALL + name.replace(/\$/g, '\\$') + String.raw`(?![\w$])`);
    const shorthand = name === 'sql' && new RegExp(String.raw`\.(?:query|execute)(?:<[^>]*>)?\(\s*\{\s*sql\s*[,}]`).test(source);
    if (passed.test(source) || shorthand) problems.push(`${name} holds a template literal with \${...} and is passed to query or execute`);
  }
  return problems;
}

describe('SQL safety', () => {
  test('no SQL in src is built from template strings, so values always go through placeholders', () => {
    const offenders = sourceFiles(SRC).filter((file) => findStringBuiltSql(readFileSync(file, 'utf8')).length > 0);
    expect(offenders).toEqual([]);
  });

  test('catches a template literal passed straight to query or execute', () => {
    expect(findStringBuiltSql('await db.query(`SELECT * FROM players WHERE roblox_user_id = ${id}`)')).toHaveLength(1);
    expect(findStringBuiltSql('await conn.execute<RowDataPacket[]>(`DELETE FROM flags WHERE flag_key = ${key}`)')).toHaveLength(1);
  });

  test('catches the object form, query({ sql: `...${x}` })', () => {
    expect(findStringBuiltSql('await db.query({ sql: `SELECT * FROM players WHERE id = ${id}`, timeout: 500 })')).toHaveLength(1);
  });

  test('catches a template literal held in a variable and passed in later', () => {
    const viaVariable = ['const statement = `SELECT * FROM players WHERE id = ${id}`;', 'const [rows] = await db.execute<RowDataPacket[]>(statement);'].join('\n');
    expect(findStringBuiltSql(viaVariable)).toEqual(['statement holds a template literal with ${...} and is passed to query or execute']);
    const typed = ['let text: string = `DELETE FROM flags WHERE flag_key = ${key}`;', 'await db.query({ sql: text, timeout: 500 });'].join('\n');
    expect(findStringBuiltSql(typed)).toHaveLength(1);
    const shorthand = ['const sql = `SELECT ${column} FROM players`;', 'await db.query({ sql, timeout: 500 });'].join('\n');
    expect(findStringBuiltSql(shorthand)).toHaveLength(1);
    // $ is legal in a JS name, so it must be matched as itself, not as a regex anchor.
    const dollar = ['const $sql = `SELECT * FROM players WHERE id = ${id}`;', 'await db.query($sql);'].join('\n');
    expect(findStringBuiltSql(dollar)).toEqual(['$sql holds a template literal with ${...} and is passed to query or execute']);
  });

  test('passes placeholder queries, plain template literals and template text that never reaches SQL', () => {
    const safe = [
      "await db.execute<RowDataPacket[]>('SELECT 1 FROM players WHERE roblox_user_id = ?', [id]);",
      "await db.query({ sql: 'SELECT 1', timeout: timeoutMs });",
      'await conn.execute(`INSERT INTO ledger_entries (transaction_id, amount)\n VALUES (?, ?)`, [id, amount]);',
      'const message = `player ${id} not found`;',
      'log.warn(message);',
      'await conn.query(migration.sql);',
      // A safe variable whose name merely starts with a template variable's name.
      'const statement = `statement for player ${id}`;',
      'await db.query(statementText, [id]);',
    ].join('\n');
    expect(findStringBuiltSql(safe)).toEqual([]);
  });
});
