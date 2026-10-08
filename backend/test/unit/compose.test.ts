import { describe, expect, test } from 'vitest';
import { loadSigningKey } from '../../src/compose.js';
import { MEMORY_CONFIG } from '../../src/memoryDeps.js';
import { exportPrivateKeyPem, generateKeyPair } from '../../src/modules/identity/crypto/keys.js';

describe('loadSigningKey', () => {
  test('uses the configured key, so the kid is the same on every boot', async () => {
    const original = await generateKeyPair();
    const pem = await exportPrivateKeyPem(original); // made at runtime, never committed
    const loaded = await loadSigningKey({ ...MEMORY_CONFIG, nodeEnv: 'production', jwtPrivateKeyPem: pem });
    expect(loaded.kid).toBe(original.kid);
  });

  test('production refuses to make up a key', async () => {
    await expect(loadSigningKey({ ...MEMORY_CONFIG, nodeEnv: 'production', jwtPrivateKeyPem: null })).rejects.toThrow(
      'JWT_PRIVATE_KEY_PEM is required in production',
    );
  });

  test('development generates a fresh key at startup', async () => {
    const first = await loadSigningKey({ ...MEMORY_CONFIG, nodeEnv: 'development' });
    const second = await loadSigningKey({ ...MEMORY_CONFIG, nodeEnv: 'development' });
    expect(first.kid).not.toBe(second.kid);
  });
});
