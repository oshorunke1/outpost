import { describe, expect, test } from 'vitest';
import { FAST_ARGON2, PRODUCTION_ARGON2, createArgon2Hasher, makeDummyHash } from '../../../src/modules/identity/crypto/password.js';

describe('Argon2id hasher', () => {
  const hasher = createArgon2Hasher(FAST_ARGON2);

  test('hashes with Argon2id and the given cost', async () => {
    expect(await hasher.hash('correct horse')).toMatch(/^\$argon2id\$v=19\$m=1024,t=1,p=1\$/);
  });

  test('verifies the right password', async () => {
    const stored = await hasher.hash('correct horse');
    await expect(hasher.verify(stored, 'correct horse')).resolves.toBe(true);
  });

  test('rejects a wrong password, including a near miss and an empty string', async () => {
    const stored = await hasher.hash('correct horse');
    await expect(hasher.verify(stored, 'correct horsf')).resolves.toBe(false);
    await expect(hasher.verify(stored, '')).resolves.toBe(false);
  });

  test('salts every hash', async () => {
    expect(await hasher.hash('same')).not.toBe(await hasher.hash('same'));
  });

  test.each([
    ['plain text', 'not-a-hash'],
    ['empty string', ''],
    ['right prefix, garbage body', '$argon2id$v=19$m=1024,t=1,p=1$@@@$@@@'],
    ['truncated real hash', '$argon2id$v=19$m=1024,t=1,p=1$c29tZXNhbHQ'],
  ])('a malformed stored hash (%s) is a plain false, never a throw', async (_label, stored) => {
    await expect(hasher.verify(stored, 'anything')).resolves.toBe(false);
  });

  test('the production hasher really encodes the OWASP minimum in its output', async () => {
    const stored = await createArgon2Hasher(PRODUCTION_ARGON2).hash('correct horse');
    expect(stored.startsWith('$argon2id$v=19$')).toBe(true);
    const params = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(stored);
    expect(params).not.toBeNull();
    const [memory, time, lanes] = (params ?? []).slice(1).map(Number);
    expect(memory).toBeGreaterThanOrEqual(19_456);
    expect(time).toBeGreaterThanOrEqual(2);
    expect(lanes).toBeGreaterThanOrEqual(1);
    expect(stored).toContain('m=19456,t=2,p=1');
  });

  test('the dummy hash is a real Argon2id hash that no input verifies against', async () => {
    const dummy = await makeDummyHash(hasher);
    expect(dummy).toMatch(/^\$argon2id\$v=19\$m=1024,t=1,p=1\$/);
    for (const guess of ['', 'password', 'correct horse', dummy, '0'.repeat(32)]) {
      await expect(hasher.verify(dummy, guess)).resolves.toBe(false);
    }
  });

  test('two dummy hashes differ, so none is a fixed known value', async () => {
    expect(await makeDummyHash(hasher)).not.toBe(await makeDummyHash(hasher));
  });
});
