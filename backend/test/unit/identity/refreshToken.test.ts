import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { hashSecret, mintRefreshToken, parseRefreshToken } from '../../../src/modules/identity/crypto/refreshToken.js';

describe('refresh tokens', () => {
  test('a minted token is <familyId>.<secret> with a 256 bit secret, and only its SHA-256 is returned', () => {
    const familyId = randomUUID();
    const minted = mintRefreshToken(familyId);
    const parsed = parseRefreshToken(minted.token);
    expect(parsed?.familyId).toBe(familyId);
    const secret = parsed?.secret ?? '';
    expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
    expect(minted.hash).toBe(createHash('sha256').update(secret).digest('hex'));
    expect(minted.hash).toBe(hashSecret(secret));
    expect(minted.token).not.toContain(minted.hash);
  });

  test('secrets never repeat', () => {
    const familyId = randomUUID();
    const hashes = new Set(Array.from({ length: 200 }, () => mintRefreshToken(familyId).hash));
    expect(hashes.size).toBe(200);
  });

  test('minting refuses a family id that would not parse back', () => {
    expect(() => mintRefreshToken('not-a-uuid')).toThrow(/family id/);
  });

  const familyId = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const secret = 'A'.repeat(43);
  const hostile: [string, unknown][] = [
    ['empty', ''],
    ['no separator', `${familyId}${secret}`],
    ['two separators', `${familyId}.${secret}.${secret}`],
    ['secret one short', `${familyId}.${'A'.repeat(42)}`],
    ['secret one long', `${familyId}.${'A'.repeat(44)}`],
    ['base64 padding', `${familyId}.${'A'.repeat(42)}=`],
    ['standard base64 characters', `${familyId}.${'A'.repeat(41)}+/`],
    ['upper case family id', `${familyId.toUpperCase()}.${secret}`],
    ['family id without dashes', `${familyId.replaceAll('-', '')}.${secret}`],
    ['trailing newline', `${familyId}.${secret}\n`],
    ['leading space', ` ${familyId}.${secret}`],
    ['null byte', `${familyId}.${'A'.repeat(42)}\u0000`],
    ['full width digits', `${familyId.replace('0', '０')}.${secret}`],
    ['a megabyte', `${familyId}.${'A'.repeat(1_000_000)}`],
    ['prototype key', '__proto__'],
    ['a JWT', 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln'],
    ['not a string', 42],
    ['null', null],
    ['an object', { toString: () => `${familyId}.${secret}` }],
  ];

  test.each(hostile)('rejects %s with null, never a throw', (_name, input) => {
    expect(parseRefreshToken(input as string)).toBeNull();
  });

  test('accepts the exact shape', () => {
    expect(parseRefreshToken(`${familyId}.${secret}`)).toEqual({ familyId, secret });
  });
});
