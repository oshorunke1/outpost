import { importJWK } from 'jose';
import type { JWK, JWTHeaderParameters } from 'jose';
import type { webcrypto } from 'node:crypto';
import { SIGNING_ALG } from './keys.js';
import { LruCache } from './lru.js';

type CryptoKey = webcrypto.CryptoKey;

export type KeyResolver = (header: JWTHeaderParameters) => Promise<CryptoKey>;

// Finds the public key for a token's kid in the key set and keeps imported keys in an LRU cache.
// The alg check here is a second line of defence: jwtVerify's algorithms allowlist already refuses
// anything but RS256 before this runs.
export function createKeyResolver(
  keySet: () => readonly JWK[],
  cache: LruCache<string, CryptoKey> = new LruCache(16),
): KeyResolver {
  return async (header) => {
    if (header.alg !== SIGNING_ALG) throw new Error(`unexpected alg ${String(header.alg)}`);
    const kid = header.kid;
    if (typeof kid !== 'string') throw new Error('the token has no kid');
    const cached = cache.get(kid);
    if (cached) return cached;
    const jwk = keySet().find((candidate) => candidate.kid === kid);
    if (!jwk) throw new Error(`unknown kid ${kid}`);
    const imported = await importJWK(jwk, SIGNING_ALG);
    if (imported instanceof Uint8Array) throw new Error('expected an RSA public key');
    cache.set(kid, imported);
    return imported;
  };
}
