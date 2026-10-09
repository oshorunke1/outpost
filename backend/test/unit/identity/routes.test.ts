import { Writable } from 'node:stream';
import { beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../../../src/app.js';
import type { AppDeps } from '../../../src/app.js';
import { MEMORY_CONFIG, createMemoryAppDeps } from '../../../src/memoryDeps.js';
import type { MemoryApp } from '../../../src/memoryDeps.js';
import type { WindowStore } from '../../../src/modules/identity/limiter/slidingWindow.js';
import type { FastifyRequest } from 'fastify';
import { requireOperator } from '../../../src/modules/identity/guards.js';
import { OPERATOR_SCOPES } from '../../../src/modules/identity/scopes.js';
import { AppError } from '../../../src/platform/errors.js';
import type { AppConfig } from '../../../src/platform/config.js';
import type { ZodApp } from '../../../src/platform/http.js';
import { createFakeClock } from '../../support/clock.js';
import type { FakeClock } from '../../support/clock.js';

const EMAIL = 'operator@outpost.local';
const PASSWORD = 'pw-1-correct-horse';

let clock: FakeClock;
let memory: MemoryApp;
let app: ZodApp;

async function start(options: { config?: Partial<AppConfig>; windowStore?: () => WindowStore } = {}) {
  clock = createFakeClock();
  memory = await createMemoryAppDeps({ clock, ...(options.windowStore ? { windowStore: options.windowStore } : {}) });
  const deps: AppDeps = { ...memory.deps, config: { ...MEMORY_CONFIG, ...options.config } };
  app = await buildApp(deps);
  await memory.operators.create({ email: EMAIL, passwordHash: await memory.hasher.hash(PASSWORD), scopes: OPERATOR_SCOPES });
}

beforeEach(async () => {
  await start();
});

const login = (password = PASSWORD, extra: { headers?: Record<string, string>; remoteAddress?: string } = {}) =>
  app.inject({ method: 'POST', url: '/auth/login', payload: { email: EMAIL, password }, ...extra });

async function accessToken(): Promise<string> {
  return (await login()).json<{ accessToken: string }>().accessToken;
}

function expectError(response: { statusCode: number; json: <T>() => T }, statusCode: number, error: string) {
  expect(response.statusCode).toBe(statusCode);
  expect(response.json<{ error: string }>().error).toBe(error);
}

describe('identity routes', () => {
  test('login returns a token pair', async () => {
    const response = await login();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
  });

  test('the email is trimmed and normalized before lookup', async () => {
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: '  Operator@Outpost.LOCAL  ', password: PASSWORD } });
    expect(response.statusCode).toBe(200);
  });

  test('a wrong password is 401 invalid_credentials', async () => {
    const response = await login('nope');
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'invalid_credentials', message: 'Email or password is incorrect' });
  });

  test('an unknown email is the same 401 invalid_credentials', async () => {
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'nobody@outpost.local', password: PASSWORD } });
    expect(response.json()).toEqual({ error: 'invalid_credentials', message: 'Email or password is incorrect' });
    expect(response.statusCode).toBe(401);
  });

  test('refresh rotates and a replay is refresh_token_reused', async () => {
    const first = (await login()).json<{ refreshToken: string }>();
    const rotated = await app.inject({ method: 'POST', url: '/auth/token/refresh', payload: { refreshToken: first.refreshToken } });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json()).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
    const replay = await app.inject({ method: 'POST', url: '/auth/token/refresh', payload: { refreshToken: first.refreshToken } });
    expectError(replay, 401, 'refresh_token_reused');
  });

  test('a well formed refresh token nobody issued is 401 invalid_refresh_token', async () => {
    const forged = `${crypto.randomUUID()}.${'A'.repeat(43)}`;
    const response = await app.inject({ method: 'POST', url: '/auth/token/refresh', payload: { refreshToken: forged } });
    expectError(response, 401, 'invalid_refresh_token');
  });

  test('sessions, logout and the bearer guard', async () => {
    const auth = { authorization: `Bearer ${await accessToken()}` };
    const sessions = await app.inject({ method: 'GET', url: '/auth/sessions', headers: auth });
    expect(sessions.statusCode).toBe(200);
    expect(sessions.json<{ sessions: unknown[] }>().sessions).toEqual([
      expect.objectContaining({ ip: '127.0.0.1', userAgent: 'lightMyRequest', current: true }),
    ]);
    expectError(await app.inject({ method: 'GET', url: '/auth/sessions' }), 401, 'unauthorized');
    const missing = await app.inject({ method: 'DELETE', url: `/auth/sessions/${crypto.randomUUID()}`, headers: auth });
    expectError(missing, 404, 'session_not_found');
    const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers: auth });
    expect(logout.statusCode).toBe(204);
    expect(logout.body).toBe('');
    expectError(await app.inject({ method: 'GET', url: '/auth/sessions', headers: auth }), 401, 'unauthorized');
  });

  test('DELETE /auth/sessions/:id ends that session', async () => {
    const mine = { authorization: `Bearer ${await accessToken()}` };
    const other = await accessToken();
    const list = (await app.inject({ method: 'GET', url: '/auth/sessions', headers: mine })).json<{ sessions: { sessionId: string; current: boolean }[] }>();
    const target = list.sessions.find((s) => !s.current)?.sessionId;
    const response = await app.inject({ method: 'DELETE', url: `/auth/sessions/${target}`, headers: mine });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expectError(await app.inject({ method: 'GET', url: '/auth/sessions', headers: { authorization: `Bearer ${other}` } }), 401, 'unauthorized');
  });

  test('logout/all ends every session of the operator', async () => {
    const a = await accessToken();
    const b = await accessToken();
    const all = await app.inject({ method: 'POST', url: '/auth/logout/all', headers: { authorization: `Bearer ${a}` } });
    expect(all.statusCode).toBe(204);
    expect({ body: all.body, type: all.headers['content-type'] }).toEqual({ body: '', type: undefined });
    for (const token of [a, b]) {
      expectError(await app.inject({ method: 'GET', url: '/auth/sessions', headers: { authorization: `Bearer ${token}` } }), 401, 'unauthorized');
    }
  });

  test('the JWKS endpoint serves public keys with a cache header and no private members', async () => {
    const response = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=300');
    const { keys } = response.json<{ keys: Record<string, unknown>[] }>();
    expect(keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' });
    for (const member of ['d', 'p', 'q', 'dp', 'dq', 'qi']) expect(response.body).not.toContain(`"${member}"`);
  });

  test('the JWKS route strips private members even if the token service leaked them', async () => {
    const leaky = memory.deps.tokens.jwks().keys.map((key) => ({ ...key, d: 'secret-d', p: 'secret-p', q: 'secret-q' }));
    const leakyApp = await buildApp({ ...memory.deps, tokens: { ...memory.deps.tokens, jwks: () => ({ keys: leaky }) } });
    const response = await leakyApp.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('secret-');
    const { keys } = response.json<{ keys: Record<string, unknown>[] }>();
    expect(Object.keys(keys[0] ?? {}).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use']);
  });
});

describe('input validation', () => {
  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as Record<string, unknown> });

  test('extra body fields are refused', async () => {
    expectError(await post('/auth/login', { email: EMAIL, password: PASSWORD, admin: true }), 400, 'invalid_request');
  });

  test('an email over 254 characters is refused', async () => {
    expectError(await post('/auth/login', { email: `${'a'.repeat(243)}@outpost.dev`, password: PASSWORD }), 400, 'invalid_request');
  });

  test('a password over 1024 characters is refused before Argon2 ever sees it', async () => {
    expectError(await post('/auth/login', { email: EMAIL, password: 'x'.repeat(1025) }), 400, 'invalid_request');
    expectError(await post('/auth/login', { email: EMAIL, password: '' }), 400, 'invalid_request');
  });

  test('a refresh token that is not the minted shape is refused', async () => {
    expectError(await post('/auth/token/refresh', { refreshToken: 'garbage' }), 400, 'invalid_request');
    expectError(await post('/auth/token/refresh', { refreshToken: `${crypto.randomUUID()}.${'A'.repeat(44)}` }), 400, 'invalid_request');
    expectError(await post('/auth/token/refresh', {}), 400, 'invalid_request');
  });

  test('a session id that is not a uuid is refused', async () => {
    const response = await app.inject({ method: 'DELETE', url: '/auth/sessions/not-a-uuid', headers: { authorization: `Bearer ${await accessToken()}` } });
    expectError(response, 400, 'invalid_request');
  });

  test('a body over the size limit is refused with 413 payload_too_large', async () => {
    const response = await post('/auth/login', { email: EMAIL, password: 'x'.repeat(20 * 1024) });
    expectError(response, 413, 'payload_too_large');
  });

  test('a body that is not JSON is refused with 415 unsupported_media_type', async () => {
    const response = await app.inject({ method: 'POST', url: '/auth/login', headers: { 'content-type': 'application/xml' }, payload: '<login/>' });
    expectError(response, 415, 'unsupported_media_type');
  });

  test('any other framework 4xx is bad_request, never a framework code', async () => {
    const response = await app.inject({ method: 'POST', url: '/auth/login', headers: { 'content-type': 'application/json' }, payload: '{"email":' });
    expectError(response, 400, 'bad_request');
  });
});

describe('the operator guard', () => {
  test.each([
    ['a lower case scheme', (t: string) => `bearer ${t}`],
    ['another scheme', (t: string) => `Basic ${t}`],
    ['two spaces', (t: string) => `Bearer  ${t}`],
    ['an empty token', () => 'Bearer '],
    ['a scheme alone', () => 'Bearer'],
    ['a second token', (t: string) => `Bearer ${t} ${t}`],
  ])('%s is 401 unauthorized with WWW-Authenticate: Bearer', async (_name, header) => {
    const token = await accessToken();
    const response = await app.inject({ method: 'GET', url: '/auth/sessions', headers: { authorization: header(token) } });
    expectError(response, 401, 'unauthorized');
    expect(response.headers['www-authenticate']).toBe('Bearer');
  });

  test('a missing header is 401 unauthorized with WWW-Authenticate: Bearer', async () => {
    const response = await app.inject({ method: 'POST', url: '/auth/logout' });
    expectError(response, 401, 'unauthorized');
    expect(response.headers['www-authenticate']).toBe('Bearer');
  });

  test('a stale token that parses is 401 unauthorized with WWW-Authenticate: Bearer', async () => {
    const token = await accessToken();
    await app.inject({ method: 'POST', url: '/auth/logout', headers: { authorization: `Bearer ${token}` } });
    const response = await app.inject({ method: 'GET', url: '/auth/sessions', headers: { authorization: `Bearer ${token}` } });
    expectError(response, 401, 'unauthorized');
    expect(response.headers['www-authenticate']).toBe('Bearer');
  });

  test('a service token is 401 unauthorized on an operator route', async () => {
    const service = await memory.deps.tokens.signServiceToken({ clientId: 'game', scopes: ['game:economy'] });
    const response = await app.inject({ method: 'GET', url: '/auth/sessions', headers: { authorization: `Bearer ${service}` } });
    expectError(response, 401, 'unauthorized');
    expect(response.headers['www-authenticate']).toBe('Bearer');
  });

  test('a wrong password on login is not a bearer challenge', async () => {
    const response = await login('nope');
    expectError(response, 401, 'invalid_credentials');
    expect(response.headers['www-authenticate']).toBeUndefined();
  });
});

describe('requireOperator', () => {
  const asRequest = (principal: unknown) => ({ principal }) as unknown as FastifyRequest;

  test('hands back an operator principal', () => {
    const operator = { kind: 'operator', operatorId: 'o1', sessionId: 's1', scopes: [] };
    expect(requireOperator(asRequest(operator))).toBe(operator);
  });

  test.each([
    ['no principal', null],
    ['a service principal', { kind: 'service', clientId: 'game', scopes: ['game:economy'] }],
  ])('refuses %s with 401 unauthorized', (_name, principal) => {
    let caught: unknown;
    try {
      requireOperator(asRequest(principal));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({ statusCode: 401, code: 'unauthorized' });
  });
});

describe('rate limits and failing closed', () => {
  test('a 429 carries the exact Retry-After, and the caller gets in once it has passed', async () => {
    for (let i = 0; i < 5; i++) expectError(await login('wrong'), 401, 'invalid_credentials');
    const blocked = await login();
    expectError(blocked, 429, 'rate_limited');
    // perIpAccount is 5 per 300 s and the clock sits on a window start. Six hits fill this window, so
    // the next allowed moment is 100 s into the next window, when 6 * 200/300 + 1 = 5.
    expect(blocked.headers['retry-after']).toBe('400');
    clock.advance(399_000);
    expectError(await login(), 429, 'rate_limited');
  });

  test('Retry-After is exact at a second boundary', async () => {
    for (let i = 0; i < 5; i++) await login('wrong');
    expect((await login()).headers['retry-after']).toBe('400');
    clock.advance(400_000);
    expect((await login()).statusCode).toBe(200);
  });

  test('refresh is limited per IP with Retry-After', async () => {
    const forged = `${crypto.randomUUID()}.${'A'.repeat(43)}`;
    for (let i = 0; i < 60; i++) await app.inject({ method: 'POST', url: '/auth/token/refresh', payload: { refreshToken: forged } });
    const blocked = await app.inject({ method: 'POST', url: '/auth/token/refresh', payload: { refreshToken: forged } });
    expectError(blocked, 429, 'rate_limited');
    expect(blocked.headers['retry-after']).toBe('62');
  });

  test('a broken limiter store is 503 auth_unavailable and the log never holds the password', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    // A store error that drags request data along in its own fields, the way client libraries attach
    // the failed command and its arguments.
    const leakyError = Object.assign(new Error('connection lost'), {
      command: { name: 'incr', args: [PASSWORD] },
      cause: Object.assign(new Error('socket closed'), { body: { password: PASSWORD } }),
    });
    const broken: WindowStore = { increment: () => Promise.reject(leakyError), read: () => Promise.reject(leakyError) };
    memory = await createMemoryAppDeps({ clock, windowStore: () => broken });
    const loud = await buildApp({ ...memory.deps, config: { ...MEMORY_CONFIG, logLevel: 'info' } }, { logStream: sink });
    const response = await loud.inject({ method: 'POST', url: '/auth/login', payload: { email: EMAIL, password: PASSWORD } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'auth_unavailable', message: 'Authentication is temporarily unavailable' });
    const log = lines.join('');
    expect(log).toContain('connection lost'); // the cause is still logged for the operator
    expect(log).toContain('socket closed');
    expect(log).not.toContain(PASSWORD);
    expect(response.body).not.toContain('connection lost');
  });
});

describe('trust proxy', () => {
  const spoofedAttempts = async (remoteAddress: string) => {
    const statuses: string[] = [];
    for (let i = 0; i < 10; i++) {
      const response = await login('wrong', { remoteAddress, headers: { 'x-forwarded-for': `198.51.100.${i + 1}` } });
      statuses.push(`${response.statusCode} ${response.json<{ error: string }>().error}`);
    }
    return statuses;
  };

  test('with trustProxy unset, a spoofed X-Forwarded-For does not move the caller to a fresh bucket', async () => {
    expect(MEMORY_CONFIG.trustProxy).toBe(false);
    const statuses = await spoofedAttempts('203.0.113.9');
    expect(statuses).toEqual([
      ...Array<string>(5).fill('401 invalid_credentials'),
      ...Array<string>(5).fill('429 rate_limited'),
    ]);
  });

  test('with trustProxy unset, the session records the socket address', async () => {
    const response = await login(PASSWORD, { remoteAddress: '203.0.113.9', headers: { 'x-forwarded-for': '198.51.100.1' } });
    const sessions = await app.inject({ method: 'GET', url: '/auth/sessions', headers: { authorization: `Bearer ${response.json<{ accessToken: string }>().accessToken}` } });
    expect(sessions.json<{ sessions: { ip: string }[] }>().sessions[0]?.ip).toBe('203.0.113.9');
  });

  test('with a trusted proxy range, X-Forwarded-For is honored', async () => {
    await start({ config: { trustProxy: ['203.0.113.0/24'] } });
    const statuses = await spoofedAttempts('203.0.113.9');
    expect(statuses).toEqual(Array<string>(10).fill('401 invalid_credentials'));
    const response = await login(PASSWORD, { remoteAddress: '203.0.113.9', headers: { 'x-forwarded-for': '198.51.100.77' } });
    const sessions = await app.inject({ method: 'GET', url: '/auth/sessions', headers: { authorization: `Bearer ${response.json<{ accessToken: string }>().accessToken}` } });
    expect(sessions.json<{ sessions: { ip: string }[] }>().sessions[0]?.ip).toBe('198.51.100.77');
  });

  test('a proxy outside the trusted range is not believed', async () => {
    await start({ config: { trustProxy: ['10.0.0.0/8'] } });
    const statuses = await spoofedAttempts('203.0.113.9');
    expect(statuses.slice(5)).toEqual(Array<string>(5).fill('429 rate_limited'));
  });
});
