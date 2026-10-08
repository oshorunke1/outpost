import { SignJWT, UnsecuredJWT } from 'jose';
import { describe, expect, test } from 'vitest';
import { exportPrivateKeyPem, importSigningKey } from '../../../src/modules/identity/crypto/keys.js';
import {
  AUDIENCE,
  InvalidTokenError,
  createTokenService,
  generateKeyPair,
} from '../../../src/modules/identity/crypto/tokenService.js';

// identity-service design test 7: algorithm confusion is rejected.
describe('token verification refuses forged tokens', () => {
  test('alg none', async () => {
    const tokens = createTokenService(await generateKeyPair());
    const unsigned = new UnsecuredJWT({ kind: 'operator', tv: 1, scope: '' })
      .setSubject('op-1')
      .setIssuer('outpost')
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .encode();
    await expect(tokens.verifyAccessToken(unsigned)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  test('HS256 signed with the public key as the shared secret', async () => {
    const key = await generateKeyPair();
    const tokens = createTokenService(key);
    const secret = new TextEncoder().encode(JSON.stringify(key.publicJwk));
    const forged = await new SignJWT({ kind: 'operator', tv: 1, scope: 'approvals:decide' })
      .setProtectedHeader({ alg: 'HS256', kid: key.kid, typ: 'at+jwt' })
      .setSubject('op-1')
      .setIssuer('outpost')
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(secret);
    await expect(tokens.verifyAccessToken(forged)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  test('RS256 signed by another key that claims our kid', async () => {
    const key = await generateKeyPair();
    const attacker = await generateKeyPair();
    const forged = await new SignJWT({ kind: 'operator', tv: 1, scope: '' })
      .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'at+jwt' })
      .setSubject('op-1')
      .setIssuer('outpost')
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(attacker.privateKey);
    await expect(createTokenService(key).verifyAccessToken(forged)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  test('rejects a token with the wrong issuer', async () => {
    const key = await generateKeyPair();
    const other = createTokenService(key, { issuer: 'someone-else' });
    const jwt = await other.signAccessToken({ userId: 'op-1', tokenVersion: 1 });
    await expect(createTokenService(key).verifyAccessToken(jwt)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  test('rejects a token with the wrong audience', async () => {
    const key = await generateKeyPair();
    const jwt = await new SignJWT({ kind: 'operator', tv: 1, scope: '' })
      .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'at+jwt' })
      .setSubject('op-1')
      .setIssuer('outpost')
      .setAudience('some-other-api')
      .setExpirationTime('5m')
      .sign(key.privateKey);
    await expect(createTokenService(key).verifyAccessToken(jwt)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  test('rejects a token with the wrong typ header', async () => {
    const key = await generateKeyPair();
    const jwt = await new SignJWT({ kind: 'operator', tv: 1, scope: '' })
      .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'JWT' })
      .setSubject('op-1')
      .setIssuer('outpost')
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(key.privateKey);
    await expect(createTokenService(key).verifyAccessToken(jwt)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  test('rejects a token with no kind claim', async () => {
    const key = await generateKeyPair();
    const jwt = await new SignJWT({ tv: 1, scope: '' })
      .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'at+jwt' })
      .setSubject('op-1')
      .setIssuer('outpost')
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(key.privateKey);
    const tokens = createTokenService(key);
    await expect(tokens.verifyAccessToken(jwt)).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(tokens.verifyServiceToken(jwt)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  test('a service token used as an operator token, and the other way round', async () => {
    const tokens = createTokenService(await generateKeyPair());
    const service = await tokens.signServiceToken({ clientId: 'game-server', scopes: ['game:economy'] });
    const operator = await tokens.signAccessToken({ userId: 'op-1', tokenVersion: 1 });
    await expect(tokens.verifyAccessToken(service)).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(tokens.verifyServiceToken(operator)).rejects.toBeInstanceOf(InvalidTokenError);
  });
});

describe('service tokens and the key set', () => {
  test('a service token verifies back to its client and scopes', async () => {
    const tokens = createTokenService(await generateKeyPair());
    const jwt = await tokens.signServiceToken({ clientId: 'game-server', scopes: ['game:economy', 'game:telemetry'] });
    await expect(tokens.verifyServiceToken(jwt)).resolves.toEqual({
      clientId: 'game-server',
      scopes: ['game:economy', 'game:telemetry'],
    });
  });

  test('jwks lists the public half only, and previous keys keep verifying during a rotation', async () => {
    const oldKey = await generateKeyPair();
    const newKey = await generateKeyPair();
    const oldTokens = createTokenService(oldKey);
    const rotated = createTokenService(newKey, { previousKeys: [oldKey.publicJwk] });
    const jwt = await oldTokens.signAccessToken({ userId: 'op-1', tokenVersion: 1 });

    await expect(rotated.verifyAccessToken(jwt)).resolves.toMatchObject({ userId: 'op-1' });
    const { keys } = rotated.jwks();
    expect(keys.map((k) => k.kid)).toEqual([newKey.kid, oldKey.kid]);
    for (const jwk of keys) {
      expect(jwk).not.toHaveProperty('d');
      expect(jwk).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' });
    }
  });

  test('the kid is deterministic across an export and import round trip', async () => {
    const key = await generateKeyPair();
    const again = await importSigningKey(await exportPrivateKeyPem(key));
    expect(again.kid).toBe(key.kid);
  });
});
