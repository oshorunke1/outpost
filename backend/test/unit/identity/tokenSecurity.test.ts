import { createPublicKey } from 'node:crypto';
import { SignJWT, exportJWK } from 'jose';
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
  const ALG_NOT_ALLOWED = /"alg".*not allowed/;

  test('alg none, with a real kid and the right typ so only the alg is wrong', async () => {
    const key = await generateKeyPair();
    const tokens = createTokenService(key);
    const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = [
      encode({ alg: 'none', kid: key.kid, typ: 'at+jwt' }),
      encode({
        kind: 'operator',
        tv: 1,
        scope: '',
        sub: 'op-1',
        iss: 'outpost',
        aud: AUDIENCE,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
        jti: 'x',
      }),
      '',
    ].join('.');
    const result = tokens.verifyAccessToken(unsigned);
    await expect(result).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(result).rejects.toThrow(ALG_NOT_ALLOWED);
  });

  test('HS256 signed with the public JWK as the shared secret', async () => {
    const key = await generateKeyPair();
    const tokens = createTokenService(key);
    const secret = new TextEncoder().encode(JSON.stringify(key.publicJwk));
    const forged = await new SignJWT({ kind: 'operator', tv: 1, scope: 'approvals:decide' })
      .setProtectedHeader({ alg: 'HS256', kid: key.kid, typ: 'at+jwt' })
      .setSubject('op-1')
      .setIssuer('outpost')
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setJti('x')
      .setExpirationTime('5m')
      .sign(secret);
    const result = tokens.verifyAccessToken(forged);
    await expect(result).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(result).rejects.toThrow(ALG_NOT_ALLOWED);
  });

  test('HS256 signed with the PEM encoded SPKI public key as the shared secret', async () => {
    const key = await generateKeyPair();
    const tokens = createTokenService(key);
    const pem = createPublicKey({ key: key.publicJwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' }).toString();
    const forged = await new SignJWT({ kind: 'operator', tv: 1, scope: 'approvals:decide' })
      .setProtectedHeader({ alg: 'HS256', kid: key.kid, typ: 'at+jwt' })
      .setSubject('op-1')
      .setIssuer('outpost')
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setJti('x')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(pem));
    const result = tokens.verifyAccessToken(forged);
    await expect(result).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(result).rejects.toThrow(ALG_NOT_ALLOWED);
  });

  test('RS256 signed by another key that claims our kid', async () => {
    const key = await generateKeyPair();
    const attacker = await generateKeyPair();
    const forged = await new SignJWT({ kind: 'operator', tv: 1, scope: '' })
      .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'at+jwt' })
      .setSubject('op-1')
      .setIssuer('outpost')
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setJti('x')
      .setExpirationTime('5m')
      .sign(attacker.privateKey);
    await expect(createTokenService(key).verifyAccessToken(forged)).rejects.toThrow(/signature/);
  });

  test('rejects a token with the wrong issuer', async () => {
    const key = await generateKeyPair();
    const other = createTokenService(key, { issuer: 'someone-else' });
    const jwt = await other.signAccessToken({ userId: 'op-1', tokenVersion: 1 });
    await expect(createTokenService(key).verifyAccessToken(jwt)).rejects.toThrow(/iss/);
  });

  test('rejects a token with the wrong audience', async () => {
    const key = await generateKeyPair();
    const jwt = await new SignJWT({ kind: 'operator', tv: 1, scope: '' })
      .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'at+jwt' })
      .setSubject('op-1')
      .setIssuer('outpost')
      .setAudience('some-other-api')
      .setIssuedAt()
      .setJti('x')
      .setExpirationTime('5m')
      .sign(key.privateKey);
    await expect(createTokenService(key).verifyAccessToken(jwt)).rejects.toThrow(/aud/);
  });

  test('rejects a token with the wrong typ header', async () => {
    const key = await generateKeyPair();
    const jwt = await new SignJWT({ kind: 'operator', tv: 1, scope: '' })
      .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'JWT' })
      .setSubject('op-1')
      .setIssuer('outpost')
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setJti('x')
      .setExpirationTime('5m')
      .sign(key.privateKey);
    await expect(createTokenService(key).verifyAccessToken(jwt)).rejects.toThrow(/typ/);
  });

  test('rejects a token with no kind claim', async () => {
    const key = await generateKeyPair();
    const jwt = await new SignJWT({ tv: 1, scope: '' })
      .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'at+jwt' })
      .setSubject('op-1')
      .setIssuer('outpost')
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setJti('x')
      .setExpirationTime('5m')
      .sign(key.privateKey);
    const tokens = createTokenService(key);
    await expect(tokens.verifyAccessToken(jwt)).rejects.toThrow(/not a operator token/);
    await expect(tokens.verifyServiceToken(jwt)).rejects.toThrow(/not a service token/);
  });

  test('rejects a token signed by our key that has no exp', async () => {
    const key = await generateKeyPair();
    const jwt = await new SignJWT({ kind: 'operator', tv: 1, scope: '' })
      .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'at+jwt' })
      .setSubject('op-1')
      .setIssuer('outpost')
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setJti('x')
      .sign(key.privateKey);
    await expect(createTokenService(key).verifyAccessToken(jwt)).rejects.toThrow(/exp/);
  });

  test('a service token used as an operator token, and the other way round', async () => {
    const tokens = createTokenService(await generateKeyPair());
    const service = await tokens.signServiceToken({ clientId: 'game-server', scopes: ['game:economy'] });
    const operator = await tokens.signAccessToken({ userId: 'op-1', tokenVersion: 1 });
    await expect(tokens.verifyAccessToken(service)).rejects.toThrow(/not a operator token/);
    await expect(tokens.verifyServiceToken(operator)).rejects.toThrow(/not a service token/);
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

  test('a previous key with private members is refused, so the jwks cannot leak one', async () => {
    const current = await generateKeyPair();
    const old = await generateKeyPair();
    const full = await exportJWK(old.privateKey);
    expect(() => createTokenService(current, { previousKeys: [{ ...full, kid: old.kid }] })).toThrow(/public keys/);
  });

  test('a service token refuses a blank or spaced client id and spaced scopes', async () => {
    const tokens = createTokenService(await generateKeyPair());
    await expect(tokens.signServiceToken({ clientId: '', scopes: [] })).rejects.toThrow(/clientId/);
    await expect(tokens.signServiceToken({ clientId: 'game server', scopes: [] })).rejects.toThrow(/clientId/);
    await expect(tokens.signServiceToken({ clientId: 'game', scopes: ['a b'] })).rejects.toThrow(/scope/);
  });

  test('the kid is deterministic across an export and import round trip', async () => {
    const key = await generateKeyPair();
    const again = await importSigningKey(await exportPrivateKeyPem(key));
    expect(again.kid).toBe(key.kid);
  });
});
