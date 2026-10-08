import { describe, expect, test } from 'vitest';
import { ConfigError, loadConfig } from '../../../src/platform/config.js';

const base = { DATABASE_URL: 'mysql://outpost:pw@localhost:3306/outpost', REDIS_URL: 'redis://localhost:6379/0' };

function messageOf(env: Record<string, string | undefined>): string {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error('loadConfig did not throw');
}

describe('loadConfig', () => {
  test('fills defaults', () => {
    expect(loadConfig(base)).toEqual({
      nodeEnv: 'development',
      host: '0.0.0.0',
      port: 3000,
      metricsPort: 9464,
      databaseUrl: base.DATABASE_URL,
      redisUrl: base.REDIS_URL,
      jwtIssuer: 'outpost',
      jwtPrivateKeyPem: null,
      logLevel: 'info',
      trustProxy: false,
    });
  });

  test('names every bad variable and never echoes a value', () => {
    const message = messageOf({ REDIS_URL: 'http://user:hunter2@cache:6379', PORT: '99999' });
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('REDIS_URL');
    expect(message).toContain('PORT');
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain('99999');
  });

  test('only the bad variables are named', () => {
    const message = messageOf({ ...base, PORT: '0' });
    expect(message).toContain('PORT');
    expect(message).not.toContain('DATABASE_URL');
    expect(message).not.toContain('REDIS_URL');
  });

  test('missing required variables fail with no silent default', () => {
    const message = messageOf({});
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('REDIS_URL');
  });

  test('a malformed signing key is rejected without echoing it', () => {
    const message = messageOf({ ...base, JWT_PRIVATE_KEY_PEM: 'not-a-pem-secret-material' });
    expect(message).toContain('JWT_PRIVATE_KEY_PEM');
    expect(message).not.toContain('secret-material');
  });

  // S2-F5: X-Forwarded-For is ignored unless the deployment says which proxies to believe.
  test('TRUST_PROXY defaults to trusting no proxy', () => {
    expect(loadConfig(base).trustProxy).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: '' }).trustProxy).toBe(false);
  });

  test('TRUST_PROXY takes a hop count', () => {
    expect(loadConfig({ ...base, TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(loadConfig({ ...base, TRUST_PROXY: '3' }).trustProxy).toBe(3);
  });

  test('TRUST_PROXY takes a comma separated list of addresses and CIDR ranges', () => {
    expect(loadConfig({ ...base, TRUST_PROXY: '10.0.0.0/8, 192.168.1.7 ,::1,fd00::/8' }).trustProxy).toEqual([
      '10.0.0.0/8',
      '192.168.1.7',
      '::1',
      'fd00::/8',
    ]);
  });

  test.each([
    ['true'], // trusting every hop would let any client pick its own IP
    ['yes'],
    ['0'],
    ['-1'],
    ['1.5'],
    ['33'],
    ['10.0.0.0/33'],
    ['::1/129'],
    ['10.0.0.0/8,'],
    ['300.1.1.1'],
    ['10.0.0.0/8,not-an-ip'],
  ])('TRUST_PROXY refuses %j and names the variable', (value) => {
    expect(messageOf({ ...base, TRUST_PROXY: value })).toContain('TRUST_PROXY');
  });

  test('production refuses to start without a signing key', () => {
    expect(messageOf({ ...base, NODE_ENV: 'production' })).toContain('JWT_PRIVATE_KEY_PEM is required in production');
  });

  test('production starts when the signing key is present', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----';
    expect(loadConfig({ ...base, NODE_ENV: 'production', JWT_PRIVATE_KEY_PEM: pem }).jwtPrivateKeyPem).toBe(pem);
  });
});
