import { randomUUID } from 'node:crypto';
import { SignJWT, importJWK, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import { SIGNING_ALG } from './keys.js';
import type { SigningKey } from './keys.js';

export { generateKeyPair } from './keys.js';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const AUDIENCE = 'outpost-api';
const TOKEN_TYPE = 'at+jwt';

export interface AccessTokenInput {
  userId: string;
  tokenVersion: number;
  sessionId?: string;
  scopes?: readonly string[];
}

export interface AccessClaims {
  userId: string;
  tokenVersion: number;
  sessionId: string | null;
  scopes: string[];
}

export interface TokenServiceOptions {
  issuer?: string;
  now?: () => number;
}

export interface TokenService {
  signAccessToken(input: AccessTokenInput): Promise<string>;
  verifyAccessToken(jwt: string): Promise<AccessClaims>;
}

export class InvalidTokenError extends Error {
  constructor(reason: string) {
    super(`invalid token: ${reason}`);
    this.name = 'InvalidTokenError';
  }
}

export function createTokenService(key: SigningKey, options: TokenServiceOptions = {}): TokenService {
  const issuer = options.issuer ?? 'outpost';
  const now = options.now ?? (() => Date.now());
  let publicKey: ReturnType<typeof importJWK> | undefined;
  const getPublicKey = () => (publicKey ??= importJWK(key.publicJwk, SIGNING_ALG));

  return {
    async signAccessToken(input) {
      const issuedAt = Math.floor(now() / 1000);
      return new SignJWT({
        kind: 'operator',
        tv: input.tokenVersion,
        sid: input.sessionId,
        scope: (input.scopes ?? []).join(' '),
      })
        .setProtectedHeader({ alg: SIGNING_ALG, kid: key.kid, typ: TOKEN_TYPE })
        .setSubject(input.userId)
        .setIssuer(issuer)
        .setAudience(AUDIENCE)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + ACCESS_TOKEN_TTL_SECONDS)
        .setJti(randomUUID())
        .sign(key.privateKey);
    },

    async verifyAccessToken(jwt) {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(jwt, await getPublicKey(), {
          algorithms: [SIGNING_ALG],
          issuer,
          audience: AUDIENCE,
          typ: TOKEN_TYPE,
          currentDate: new Date(now()),
        }));
      } catch (error) {
        throw new InvalidTokenError(error instanceof Error ? error.message : 'verification failed');
      }
      if (payload.kind !== 'operator' || typeof payload.sub !== 'string' || typeof payload.tv !== 'number') {
        throw new InvalidTokenError('not an operator access token');
      }
      return {
        userId: payload.sub,
        tokenVersion: payload.tv,
        sessionId: typeof payload.sid === 'string' ? payload.sid : null,
        scopes: typeof payload.scope === 'string' && payload.scope.length > 0 ? payload.scope.split(' ') : [],
      };
    },
  };
}
