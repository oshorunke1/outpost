import { createHash, randomBytes } from 'node:crypto';

// A refresh token is <familyId>.<secret>. The secret is 32 bytes from the CSPRNG (256 bits),
// base64url without padding, so always 43 characters. Stores keep only the SHA-256 of the secret,
// so a dump of Redis cannot be replayed. A plain hash is enough here, unlike passwords: the input
// is already 256 random bits, so there is nothing to brute force.
const FAMILY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;
const TOKEN_LENGTH = 36 + 1 + 43;

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function mintRefreshToken(familyId: string): { token: string; hash: string } {
  if (!FAMILY_ID.test(familyId)) throw new Error('the family id must be a lower case UUID');
  const secret = randomBytes(32).toString('base64url');
  return { token: `${familyId}.${secret}`, hash: hashSecret(secret) };
}

// Anything that is not exactly the minted shape is null. The input comes straight from a request
// body, so the type and length are checked before the regex ever runs.
export function parseRefreshToken(token: string): { familyId: string; secret: string } | null {
  if (typeof token !== 'string' || token.length !== TOKEN_LENGTH) return null;
  const match = TOKEN.exec(token);
  return match?.[1] && match[2] ? { familyId: match[1], secret: match[2] } : null;
}
