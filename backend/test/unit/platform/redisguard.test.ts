import { describe, expect, test } from 'vitest';
import { assertTestRedisDb } from '../../integration/support/guard.js';

describe('integration harness Redis guard (S2-F11)', () => {
  test('accepts db 15', () => {
    expect(() => assertTestRedisDb({ options: { db: 15 } })).not.toThrow();
  });

  test('refuses the default db 0 and says why', () => {
    expect(() => assertTestRedisDb({ options: {} })).toThrow('refusing to flush Redis db 0, integration tests only run on db 15');
  });

  test('refuses any other db', () => {
    expect(() => assertTestRedisDb({ options: { db: 3 } })).toThrow('refusing to flush Redis db 3');
  });
});
