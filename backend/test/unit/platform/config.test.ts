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
      metricsHost: '127.0.0.1',
      databaseUrl: base.DATABASE_URL,
      redisUrl: base.REDIS_URL,
      jwtIssuer: 'outpost',
      jwtPrivateKeyPem: null,
      logLevel: 'info',
      trustProxy: false,
      telemetryApiLimit: { capacity: 200, refillPerSecond: 150 },
    });
  });

  // S4-F10: the metrics server binds to loopback unless METRICS_HOST says otherwise (Compose sets 0.0.0.0).
  test('METRICS_HOST sets where the metrics server listens', () => {
    expect(loadConfig({ ...base, METRICS_HOST: '0.0.0.0' }).metricsHost).toBe('0.0.0.0');
    expect(messageOf({ ...base, METRICS_HOST: '' })).toContain('METRICS_HOST');
  });

  // S4-F5: the telemetry route has its own bucket, sized from TELEMETRY_API_LIMIT.
  test('TELEMETRY_API_LIMIT takes capacity:refill per second', () => {
    expect(loadConfig({ ...base, TELEMETRY_API_LIMIT: '50:12.5' }).telemetryApiLimit).toEqual({ capacity: 50, refillPerSecond: 12.5 });
  });

  test.each([['200'], ['0:10'], ['10:0'], ['-1:5'], ['a:b'], ['10:5:1'], ['1e3:5']])('TELEMETRY_API_LIMIT refuses %j and says the format', (value) => {
    const message = messageOf({ ...base, TELEMETRY_API_LIMIT: value });
    expect(message).toContain('TELEMETRY_API_LIMIT');
    expect(message).toContain('<capacity>:<refill per second>');
    expect(message).not.toContain(`"${value}"`);
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

  test('TRUST_PROXY takes a comma separated list of addresses and CIDR ranges', () => {
    expect(loadConfig({ ...base, TRUST_PROXY: '10.0.0.0/8, 192.168.1.7 ,::1,fd00::/8' }).trustProxy).toEqual([
      '10.0.0.0/8',
      '192.168.1.7',
      '::1',
      'fd00::/8',
    ]);
  });

  // Hop counts are refused on purpose: a client that reaches the app port directly could send enough
  // X-Forwarded-For entries to pick its own IP. Fastify 5 treats a number as trust nothing for the
  // same reason. The fix is to name the proxy's address or range.
  test.each([['1'], ['2'], ['true'], ['yes'], ['10.0.0.0/33'], ['::1/129'], ['10.0.0.0/8,'], ['300.1.1.1'], ['10.0.0.0/8,not-an-ip']])(
    'TRUST_PROXY refuses %j and says to set the proxy CIDR',
    (value) => {
      const message = messageOf({ ...base, TRUST_PROXY: value });
      expect(message).toContain('TRUST_PROXY');
      expect(message).toContain('CIDR');
      expect(message).not.toContain(`TRUST_PROXY=${value}`);
    },
  );

  test('a TRUST_PROXY problem is reported alongside other bad variables', () => {
    const message = messageOf({ ...base, PORT: '0', TRUST_PROXY: '1' });
    expect(message).toContain('PORT');
    expect(message).toContain('TRUST_PROXY');
  });

  test('production refuses to start without a signing key', () => {
    expect(messageOf({ ...base, NODE_ENV: 'production' })).toContain('JWT_PRIVATE_KEY_PEM is required in production');
  });

  test('production starts when the signing key is present', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----';
    expect(loadConfig({ ...base, NODE_ENV: 'production', JWT_PRIVATE_KEY_PEM: pem }).jwtPrivateKeyPem).toBe(pem);
  });
});
