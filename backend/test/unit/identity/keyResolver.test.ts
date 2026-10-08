import type { JWK } from 'jose';
import type { webcrypto } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { generateKeyPair } from '../../../src/modules/identity/crypto/keys.js';
import { createKeyResolver } from '../../../src/modules/identity/crypto/keyResolver.js';
import { LruCache } from '../../../src/modules/identity/crypto/lru.js';

type CryptoKey = webcrypto.CryptoKey;

describe('createKeyResolver', () => {
  test('imports each kid once and serves repeats from the cache', async () => {
    const key = await generateKeyPair();
    const cache = new LruCache<string, CryptoKey>(4);
    const resolve = createKeyResolver(() => [key.publicJwk], cache);
    const first = await resolve({ alg: 'RS256', kid: key.kid });
    const second = await resolve({ alg: 'RS256', kid: key.kid });
    expect(second).toBe(first);
    expect(cache.size).toBe(1);
  });

  test('refuses a missing kid, an unknown kid and any alg but RS256', async () => {
    const key = await generateKeyPair();
    const resolve = createKeyResolver(() => [key.publicJwk]);
    await expect(resolve({ alg: 'RS256' })).rejects.toThrow('no kid');
    await expect(resolve({ alg: 'RS256', kid: 'nope' })).rejects.toThrow('unknown kid');
    await expect(resolve({ alg: 'HS256', kid: key.kid })).rejects.toThrow('unexpected alg');
  });

  test('a kid removed from the key set is rejected even after it was cached', async () => {
    const key = await generateKeyPair();
    let keys: JWK[] = [key.publicJwk];
    const resolve = createKeyResolver(() => keys);
    await expect(resolve({ alg: 'RS256', kid: key.kid })).resolves.toBeDefined();
    keys = [];
    await expect(resolve({ alg: 'RS256', kid: key.kid })).rejects.toThrow('unknown kid');
  });
});
