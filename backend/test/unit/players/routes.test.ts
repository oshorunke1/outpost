import { beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../../../src/app.js';
import { createMemoryAppDeps } from '../../../src/memoryDeps.js';
import type { MemoryApp } from '../../../src/memoryDeps.js';
import { userIdBody, userIdParam } from '../../../src/modules/players/params.js';
import type { ZodApp } from '../../../src/platform/http.js';
import { bearer, gameToken } from '../../support/tokens.js';

let memory: MemoryApp;
let app: ZodApp;
let headers: { authorization: string };

beforeEach(async () => {
  memory = await createMemoryAppDeps();
  app = await buildApp(memory.deps);
  headers = bearer(await gameToken(memory.deps.tokens));
});

// Every path form a hostile caller might try. Each one must be refused, never coerced to a player.
const HOSTILE_IDS: Array<[label: string, path: string]> = [
  ['exponent', '1e3'],
  ['leading zeros', '007'],
  ['negative', '-5'],
  ['plus sign', '%2B5'],
  ['zero', '0'],
  ['decimal', '1.5'],
  ['hex', '0x10'],
  ['17 digits', '12345678901234567'],
  ['16 digits above MAX_SAFE_INTEGER', '9007199254740992'],
  ['16 nines', '9999999999999999'],
  ['letters', 'abc'],
  ['space', '%20'],
  ['space around digits', '%2012%20'],
  ['inner space', '1%202'],
  ['trailing newline', '12%0A'],
  ['leading tab', '%0912'],
  ['fullwidth digit', '%EF%BC%91'],
  ['arabic indic digit', '%D9%A1'],
  ['null byte', '1%00'],
  ['NaN', 'NaN'],
  ['Infinity', 'Infinity'],
];

describe('player routes', () => {
  test('join creates an empty wallet and leave answers 204', async () => {
    const joined = await app.inject({ method: 'POST', url: '/v1/players/1001/sessions', headers });
    expect(joined.statusCode).toBe(200);
    expect(joined.json()).toEqual({ userId: 1001, balance: 0 });
    expect((await app.inject({ method: 'GET', url: '/v1/players/1001/wallet', headers })).json()).toEqual({ userId: 1001, balance: 0 });
    expect((await app.inject({ method: 'POST', url: '/v1/players/1001/sessions/end', headers })).statusCode).toBe(204);
  });

  test('a wallet for a player who never joined is 404 player_not_found', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/players/2002/wallet', headers });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'player_not_found' });
    const left = await app.inject({ method: 'POST', url: '/v1/players/2002/sessions/end', headers });
    expect(left.statusCode).toBe(404);
    expect(left.json()).toMatchObject({ error: 'player_not_found' });
  });

  // Review Focus 2: an id is never coerced into some other player's id.
  test.each(HOSTILE_IDS)('non-canonical id (%s) is refused with 400 invalid_request on every route', async (_label, id) => {
    for (const [method, suffix] of [
      ['GET', 'wallet'],
      ['POST', 'sessions'],
      ['POST', 'sessions/end'],
    ] as const) {
      const response = await app.inject({ method, url: `/v1/players/${id}/${suffix}`, headers });
      expect({ id, status: response.statusCode, code: response.json<{ error: string }>().error }).toEqual({
        id,
        status: 400,
        code: 'invalid_request',
      });
    }
    // Nothing was created for any player along the way.
    expect((await app.inject({ method: 'GET', url: '/v1/players/1/wallet', headers })).statusCode).toBe(404);
  });

  test('an empty id never reaches a player', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/players//wallet', headers });
    expect([400, 404]).toContain(response.statusCode);
    expect(['invalid_request', 'not_found']).toContain(response.json<{ error: string }>().error);
  });

  test('the largest safe integer and a small id are accepted', async () => {
    for (const userId of [1, Number.MAX_SAFE_INTEGER]) {
      const response = await app.inject({ method: 'POST', url: `/v1/players/${userId}/sessions`, headers });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ userId, balance: 0 });
    }
  });

  test('the routes need the game:economy scope', async () => {
    const telemetryOnly = bearer(await gameToken(memory.deps.tokens, ['game:telemetry']));
    for (const [method, url] of [
      ['POST', '/v1/players/1001/sessions'],
      ['POST', '/v1/players/1001/sessions/end'],
      ['GET', '/v1/players/1001/wallet'],
    ] as const) {
      const response = await app.inject({ method, url, headers: telemetryOnly });
      expect({ url, status: response.statusCode, code: response.json<{ error: string }>().error }).toEqual({
        url,
        status: 403,
        code: 'insufficient_scope',
      });
    }
  });

  test('no token, a junk token and an operator token are all 401 with a Bearer challenge', async () => {
    const operator = bearer(await memory.deps.tokens.signAccessToken({ userId: 'op-1', tokenVersion: 1 }));
    for (const requestHeaders of [{}, { authorization: 'Bearer junk' }, operator]) {
      const response = await app.inject({ method: 'POST', url: '/v1/players/1001/sessions', headers: requestHeaders });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: 'unauthorized' });
      expect(response.headers['www-authenticate']).toBe('Bearer');
    }
  });

  test('auth runs before id parsing, so a bad id with no token is 401 not 400', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/players/1e3/wallet' });
    expect(response.statusCode).toBe(401);
  });
});

describe('userIdParam and userIdBody', () => {
  test('param parses only canonical positive safe integers', () => {
    expect(userIdParam.parse('1')).toBe(1);
    expect(userIdParam.parse('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
    for (const bad of ['', '0', '01', '1e3', '-1', '+1', '1.0', '0x1', ' 1', '1 ', '1\n', '９', '9007199254740992']) {
      expect(userIdParam.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  test('body accepts only positive safe integers', () => {
    expect(userIdBody.parse(1)).toBe(1);
    expect(userIdBody.parse(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, '5', null]) {
      expect(userIdBody.safeParse(bad).success, String(bad)).toBe(false);
    }
  });
});
