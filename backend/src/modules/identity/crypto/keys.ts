import { calculateJwkThumbprint, exportJWK, exportPKCS8, generateKeyPair as joseGenerateKeyPair, importPKCS8 } from 'jose';
import type { JWK } from 'jose';
import type { webcrypto } from 'node:crypto';

type CryptoKey = webcrypto.CryptoKey;

export const SIGNING_ALG = 'RS256';

// A signing key plus the public half that goes into the JWKS. The kid is the RFC 7638 thumbprint,
// so the same key always gets the same id on every restart.
export interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
}

async function fromPrivateKey(privateKey: CryptoKey): Promise<SigningKey> {
  const full = await exportJWK(privateKey);
  if (full.kty !== 'RSA' || !full.n || !full.e) {
    throw new Error('the signing key must be an RSA key');
  }
  const bare: JWK = { kty: 'RSA', n: full.n, e: full.e };
  const kid = await calculateJwkThumbprint(bare);
  return { kid, privateKey, publicJwk: { ...bare, kid, alg: SIGNING_ALG, use: 'sig' } };
}

export async function generateKeyPair(): Promise<SigningKey> {
  const { privateKey } = await joseGenerateKeyPair(SIGNING_ALG, { modulusLength: 2048, extractable: true });
  return fromPrivateKey(privateKey);
}

export async function importSigningKey(pkcs8Pem: string): Promise<SigningKey> {
  return fromPrivateKey(await importPKCS8(pkcs8Pem, SIGNING_ALG, { extractable: true }));
}

export async function exportPrivateKeyPem(key: SigningKey): Promise<string> {
  return exportPKCS8(key.privateKey);
}
