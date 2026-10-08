import { decodeProtectedHeader } from 'jose';
import { describe, expect, test } from 'vitest';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  InvalidTokenError,
  createTokenService,
  generateKeyPair,
} from '../../../src/modules/identity/crypto/tokenService.js';

describe('access tokens', () => {
  test('carry the session id and scopes', async () => {
    const tokens = createTokenService(await generateKeyPair());
    const jwt = await tokens.signAccessToken({
      userId: 'op-1',
      tokenVersion: 3,
      sessionId: 'session-9',
      scopes: ['admin:read', 'approvals:decide'],
    });
    await expect(tokens.verifyAccessToken(jwt)).resolves.toEqual({
      userId: 'op-1',
      tokenVersion: 3,
      sessionId: 'session-9',
      scopes: ['admin:read', 'approvals:decide'],
    });
  });

  test('use RS256 with the key id and the at+jwt type', async () => {
    const key = await generateKeyPair();
    const jwt = await createTokenService(key).signAccessToken({ userId: 'op-1', tokenVersion: 1 });
    expect(decodeProtectedHeader(jwt)).toEqual({ alg: 'RS256', kid: key.kid, typ: 'at+jwt' });
  });

  test('expire after 15 minutes', async () => {
    let nowMs = Date.UTC(2026, 9, 8, 12, 0, 0);
    const tokens = createTokenService(await generateKeyPair(), { now: () => nowMs });
    const jwt = await tokens.signAccessToken({ userId: 'op-1', tokenVersion: 1 });
    nowMs += ACCESS_TOKEN_TTL_SECONDS * 1000 - 1000;
    await expect(tokens.verifyAccessToken(jwt)).resolves.toMatchObject({ userId: 'op-1' });
    nowMs += 2000;
    await expect(tokens.verifyAccessToken(jwt)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  test('are refused by a service holding a different key', async () => {
    const issuer = createTokenService(await generateKeyPair());
    const stranger = createTokenService(await generateKeyPair());
    const jwt = await issuer.signAccessToken({ userId: 'op-1', tokenVersion: 1 });
    await expect(stranger.verifyAccessToken(jwt)).rejects.toBeInstanceOf(InvalidTokenError);
  });
});
