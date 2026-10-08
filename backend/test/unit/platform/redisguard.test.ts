import { describe, expect, test } from 'vitest';
import { assertSafeTestUrls, assertTestRedisDb } from '../../integration/support/guard.js';

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

describe('integration harness URL guard (M4)', () => {
  const redis = 'redis://127.0.0.1:6379/15';
  test('accepts bare loopback URLs', () => {
    expect(() => assertSafeTestUrls('mysql://root:pw@127.0.0.1:3306', redis)).not.toThrow();
    expect(() => assertSafeTestUrls('mysql://root:pw@localhost:3306/', 'redis://[::1]:6379/15')).not.toThrow();
  });

  test('refuses a MySQL URL that names a database', () => {
    expect(() => assertSafeTestUrls('mysql://root:pw@127.0.0.1:3306/outpost', redis)).toThrow('bare server URL with no database name');
  });

  test('refuses a remote MySQL host and says which variable', () => {
    expect(() => assertSafeTestUrls('mysql://root:pw@db.example.com:3306', redis)).toThrow('TEST_MYSQL_URL must point at a loopback host');
  });

  test('refuses a remote Redis host', () => {
    expect(() => assertSafeTestUrls('mysql://root:pw@127.0.0.1:3306', 'redis://cache.example.com:6379/15')).toThrow(
      'TEST_REDIS_URL must point at a loopback host',
    );
  });

  test('refuses text that is not a URL without echoing it', () => {
    expect(() => assertSafeTestUrls('not a url', redis)).toThrow('TEST_MYSQL_URL is not a valid URL');
  });
});
