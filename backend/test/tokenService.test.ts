import { describe, test, expect } from 'vitest';
import { generateKeyPair, createTokenService } from '../src/crypto/tokenService.js';

describe('token service', () => {
  test('signs an access token that verifies back to the same subject', async () => {
    const keys = await generateKeyPair();
    const tokens = createTokenService(keys);

    const jwt = await tokens.signAccessToken({ userId: 'user-123', tokenVersion: 1 });
    const claims = await tokens.verifyAccessToken(jwt);

    expect(claims.userId).toBe('user-123');
    expect(claims.tokenVersion).toBe(1);
  });
});
