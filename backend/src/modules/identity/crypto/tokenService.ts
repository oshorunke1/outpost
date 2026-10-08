import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { JWK, JWTPayload } from 'jose';
import { createKeyResolver } from './keyResolver.js';
import { SIGNING_ALG } from './keys.js';
import type { SigningKey } from './keys.js';
import { LruCache } from './lru.js';

export { generateKeyPair } from './keys.js';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const AUDIENCE = 'outpost-api';
const TOKEN_TYPE = 'at+jwt';

type TokenKind = 'operator' | 'service';

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

export interface ServiceTokenInput {
  clientId: string;
  scopes: readonly string[];
}

export interface ServiceClaims {
  clientId: string;
  scopes: string[];
}

export interface TokenServiceOptions {
  issuer?: string;
  now?: () => number;
  // Public keys that still verify while a key rotation finishes. They never sign.
  previousKeys?: readonly JWK[];
}

export interface TokenService {
  signAccessToken(input: AccessTokenInput): Promise<string>;
  verifyAccessToken(jwt: string): Promise<AccessClaims>;
  signServiceToken(input: ServiceTokenInput): Promise<string>;
  verifyServiceToken(jwt: string): Promise<ServiceClaims>;
  jwks(): { keys: JWK[] };
}

export class InvalidTokenError extends Error {
  constructor(reason: string) {
    super(`invalid token: ${reason}`);
    this.name = 'InvalidTokenError';
  }
}

function scopesOf(payload: JWTPayload): string[] {
  return typeof payload.scope === 'string' && payload.scope.length > 0 ? payload.scope.split(' ') : [];
}

export function createTokenService(key: SigningKey, options: TokenServiceOptions = {}): TokenService {
  const issuer = options.issuer ?? 'outpost';
  const now = options.now ?? (() => Date.now());
  const keySet: JWK[] = [key.publicJwk, ...(options.previousKeys ?? [])];
  const resolveKey = createKeyResolver(() => keySet, new LruCache(16));

  async function sign(kind: TokenKind, subject: string, claims: Record<string, unknown>): Promise<string> {
    const issuedAt = Math.floor(now() / 1000);
    return new SignJWT({ ...claims, kind })
      .setProtectedHeader({ alg: SIGNING_ALG, kid: key.kid, typ: TOKEN_TYPE })
      .setSubject(subject)
      .setIssuer(issuer)
      .setAudience(AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ACCESS_TOKEN_TTL_SECONDS)
      .setJti(randomUUID())
      .sign(key.privateKey);
  }

  async function verify(jwt: string, kind: TokenKind): Promise<JWTPayload & { sub: string }> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(jwt, resolveKey, {
        algorithms: [SIGNING_ALG],
        issuer,
        audience: AUDIENCE,
        typ: TOKEN_TYPE,
        currentDate: new Date(now()),
      }));
    } catch (error) {
      throw new InvalidTokenError(error instanceof Error ? error.message : 'verification failed');
    }
    if (payload.kind !== kind || typeof payload.sub !== 'string') {
      throw new InvalidTokenError(`not a ${kind} token`);
    }
    return payload as JWTPayload & { sub: string };
  }

  return {
    signAccessToken: (input) =>
      sign('operator', input.userId, {
        tv: input.tokenVersion,
        sid: input.sessionId,
        scope: (input.scopes ?? []).join(' '),
      }),

    async verifyAccessToken(jwt) {
      const payload = await verify(jwt, 'operator');
      if (typeof payload.tv !== 'number') throw new InvalidTokenError('missing token version');
      return {
        userId: payload.sub,
        tokenVersion: payload.tv,
        sessionId: typeof payload.sid === 'string' ? payload.sid : null,
        scopes: scopesOf(payload),
      };
    },

    signServiceToken: (input) => sign('service', `svc:${input.clientId}`, { scope: input.scopes.join(' ') }),

    async verifyServiceToken(jwt) {
      const payload = await verify(jwt, 'service');
      if (!payload.sub.startsWith('svc:')) throw new InvalidTokenError('a service subject starts with svc:');
      return { clientId: payload.sub.slice('svc:'.length), scopes: scopesOf(payload) };
    },

    jwks: () => ({ keys: keySet.map((jwk) => ({ ...jwk })) }),
  };
}
