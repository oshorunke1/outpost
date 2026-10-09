import { describe, expect, test } from 'vitest';
import { CATALOG } from '../../../src/modules/economy/catalog.js';
import { DEMO_PRICES, DemoError, describeFetchError, mainDemo, readDemoConfig, runDemo, waitForReady } from '../../../scripts/demoFlow.js';
import type { DemoConfig, FetchLike } from '../../../scripts/demoFlow.js';

const KEY = `opk_game-server.${'a'.repeat(43)}`;
const BASE = 'http://backend.test';

describe('readDemoConfig', () => {
  test('needs the game API key, with a hint', () => {
    expect(() => readDemoConfig({})).toThrow(/OUTPOST_GAME_API_KEY is not set\. Run pnpm setup:dev/);
    expect(() => readDemoConfig({ OUTPOST_GAME_API_KEY: '' })).toThrow(DemoError);
  });

  test('defaults the URL and picks a random safe user id per run', () => {
    const picks = [readDemoConfig({ OUTPOST_GAME_API_KEY: KEY }), readDemoConfig({ OUTPOST_GAME_API_KEY: KEY })];
    for (const config of picks) {
      expect(config.baseUrl).toBe('http://127.0.0.1:3000');
      expect(config.apiKey).toBe(KEY);
      expect(Number.isSafeInteger(config.userId) && config.userId > 0).toBe(true);
      expect(config.userIdSource).toBe('random');
    }
    expect(picks[0]?.userId).not.toBe(picks[1]?.userId);
    expect(readDemoConfig({ OUTPOST_GAME_API_KEY: KEY }, () => 42).userId).toBe(42);
  });

  test('takes OUTPOST_DEMO_USER_ID when it is a positive whole number', () => {
    const config = readDemoConfig({ OUTPOST_GAME_API_KEY: KEY, OUTPOST_DEMO_USER_ID: '9007199254740991' });
    expect(config).toMatchObject({ userId: 9007199254740991, userIdSource: 'env' });
  });

  test('an empty OUTPOST_DEMO_USER_ID means a random player, as an env file often leaves it', () => {
    expect(readDemoConfig({ OUTPOST_GAME_API_KEY: KEY, OUTPOST_DEMO_USER_ID: '' }, () => 7)).toMatchObject({ userId: 7, userIdSource: 'random' });
  });

  test.each(['0', '-5', '1.5', '1e3', '007', 'abc', ' 12', '9007199254740992', '12345678901234567'])(
    'refuses OUTPOST_DEMO_USER_ID %j with a clear error',
    (value) => {
      expect(() => readDemoConfig({ OUTPOST_GAME_API_KEY: KEY, OUTPOST_DEMO_USER_ID: value })).toThrow(
        `OUTPOST_DEMO_USER_ID must be a whole number from 1 to 9007199254740991 (got ${JSON.stringify(value)})`,
      );
    },
  );

  test('takes OUTPOST_BACKEND_URL, drops a trailing slash and refuses anything but http(s)', () => {
    expect(readDemoConfig({ OUTPOST_GAME_API_KEY: KEY, OUTPOST_BACKEND_URL: 'http://localhost:13000/' }).baseUrl).toBe('http://localhost:13000');
    expect(readDemoConfig({ OUTPOST_GAME_API_KEY: KEY, OUTPOST_BACKEND_URL: 'https://api.example.test/outpost/' }).baseUrl).toBe('https://api.example.test/outpost');
    for (const bad of ['localhost:3000', 'ftp://x', 'not a url', 'http://host/?x=1', 'http://host/#top']) {
      expect(() => readDemoConfig({ OUTPOST_GAME_API_KEY: KEY, OUTPOST_BACKEND_URL: bad })).toThrow(/OUTPOST_BACKEND_URL must be an http or https URL/);
    }
  });

  test('refuses a backend URL with credentials and never echoes them', () => {
    for (const bad of ['http://user:hunter2-pass@host:3000', 'http://hunter2-only@host']) {
      let message = '';
      try {
        readDemoConfig({ OUTPOST_GAME_API_KEY: KEY, OUTPOST_BACKEND_URL: bad });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/OUTPOST_BACKEND_URL must not carry a user name or password/);
      expect(message).not.toContain('hunter2');
    }
  });

  test('never echoes a URL that does not parse, since it may still hold a password', () => {
    let message = '';
    try {
      readDemoConfig({ OUTPOST_GAME_API_KEY: KEY, OUTPOST_BACKEND_URL: 'http://user:hunter2-pass@host:99999' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/OUTPOST_BACKEND_URL must be an http or https URL/);
    expect(message).not.toContain('hunter2');
  });

  test('reads OUTPOST_JAEGER_URL for the closing hint, default http://localhost:16686', () => {
    expect(readDemoConfig({ OUTPOST_GAME_API_KEY: KEY }).jaegerUrl).toBe('http://localhost:16686');
    expect(readDemoConfig({ OUTPOST_GAME_API_KEY: KEY, OUTPOST_JAEGER_URL: 'http://127.0.0.1:26686/' }).jaegerUrl).toBe('http://127.0.0.1:26686');
    for (const bad of ['jaeger:16686', 'ftp://x', 'http://u:p@host', 'http://host/?q=1']) {
      expect(() => readDemoConfig({ OUTPOST_GAME_API_KEY: KEY, OUTPOST_JAEGER_URL: bad })).toThrow(/OUTPOST_JAEGER_URL must/);
    }
  });

  test.each([
    ['a line break', `opk_game-server.${'s'.repeat(40)}\nTAILSECRET`],
    ['a trailing space', `${KEY} `],
    ['a NUL', `opk_game-server.${'s'.repeat(40)}\u0000x`],
    ['no client id', `opk_.${'s'.repeat(43)}`],
    ['no prefix', `game-server.${'s'.repeat(43)}`],
    ['a short secret', 'opk_game-server.short'],
  ])('refuses a key with %s without echoing it', (_label, key) => {
    let message = '';
    try {
      readDemoConfig({ OUTPOST_GAME_API_KEY: key });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('OUTPOST_GAME_API_KEY is not a well-formed key (expected opk_<clientId>.<secret>)');
  });
});

describe('describeFetchError', () => {
  test('names the network cause instead of just "fetch failed"', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3000'), { code: 'ECONNREFUSED' });
    expect(describeFetchError(new TypeError('fetch failed', { cause: refused }))).toBe('ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:3000');
    // Node reports a refused dual stack connect as an AggregateError with an empty message.
    const both = Object.assign(new AggregateError([refused], ''), { code: 'ECONNREFUSED' });
    expect(describeFetchError(new TypeError('fetch failed', { cause: both }))).toBe('ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:3000');
    expect(describeFetchError(new Error('boom'))).toBe('boom');
    expect(describeFetchError('odd')).toBe('odd');
  });
});

// A fake clock and sleep, so the readiness poll runs instantly.
function fakeTime() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('waitForReady', () => {
  test('polls with backoff until /readyz says ready', async () => {
    const time = fakeTime();
    const answers = [
      () => Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })),
      () => Promise.resolve(json(503, { status: 'not_ready', checks: { mysql: 'fail', redis: 'ok' } })),
      () => Promise.resolve(json(200, { status: 'ready', checks: { mysql: 'ok', redis: 'ok' } })),
    ];
    const urls: string[] = [];
    const fetch: FetchLike = (url) => {
      urls.push(String(url));
      const next = answers.shift();
      if (!next) throw new Error('polled too often');
      return next();
    };
    const ready = await waitForReady({ baseUrl: BASE, fetch, ...time });
    expect(ready).toEqual({ status: 'ready', checks: { mysql: 'ok', redis: 'ok' } });
    expect(urls).toEqual([`${BASE}/readyz`, `${BASE}/readyz`, `${BASE}/readyz`]);
    expect(time.sleeps).toEqual([250, 500]);
  });

  test('never lets one readyz request run past the deadline', async () => {
    const time = fakeTime();
    const limits: number[] = [];
    const refused: FetchLike = () => Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }));
    const requestTimeout = (ms: number) => {
      limits.push(ms);
      return AbortSignal.timeout(ms);
    };
    await expect(waitForReady({ baseUrl: BASE, fetch: refused, ...time, timeoutMs: 2_000, requestTimeout })).rejects.toThrow(/within 2s/);
    expect(limits).toEqual([2_000, 1_750, 1_250, 250]);
  });

  test('gives up after the timeout and says what it last saw', async () => {
    const time = fakeTime();
    const notReady: FetchLike = async () => json(503, { status: 'not_ready', checks: { mysql: 'fail', redis: 'ok' } });
    await expect(waitForReady({ baseUrl: BASE, fetch: notReady, ...time })).rejects.toThrow(
      `the backend at ${BASE} was not ready within 60s; last answer HTTP 503 not_ready (mysql fail, redis ok)`,
    );
    expect(time.now()).toBe(60_000);
    expect(Math.max(...time.sleeps)).toBe(5_000);

    const down = fakeTime();
    const refused: FetchLike = () =>
      Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3000'), { code: 'ECONNREFUSED' }) }));
    await expect(waitForReady({ baseUrl: BASE, fetch: refused, ...down, timeoutMs: 2_000 })).rejects.toThrow(
      `the backend at ${BASE} was not ready within 2s; last error ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:3000. Is the stack up? Try docker compose up -d --build --wait`,
    );
  });
});

test('the demo prices match the backend catalog', () => {
  expect(DEMO_PRICES).toEqual({ RedHat: CATALOG.RedHat.price, GoldCrown: CATALOG.GoldCrown.price });
});

// A small stand-in for the backend that answers the demo's calls like the real routes do. Each
// test can break one answer to prove the demo checks that field.
interface FakeOptions {
  apiKey?: string;
  startBalance?: number;
  telemetryEnabled?: boolean;
  tamper?: (path: string, method: string, status: number, body: Record<string, unknown>) => { status: number; body: unknown; headers?: Record<string, string> } | undefined;
}

function fakeBackend(options: FakeOptions = {}) {
  const balances = new Map<number, number>();
  const byKey = new Map<string, Record<string, unknown>>();
  const unfulfilled = new Map<string, { transactionId: string; itemId: string; createdAt: string }>();
  const seen: string[] = [];
  let next = 0;
  const id = () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`;

  const answer = (path: string, method: string, headers: Record<string, string>, body: unknown): { status: number; body: unknown; headers?: Record<string, string> } => {
    if (path === '/readyz') return { status: 200, body: { status: 'ready', checks: { mysql: 'ok', redis: 'ok' } } };
    if (path === '/auth/service-token') {
      if (headers.authorization !== `ApiKey ${options.apiKey ?? KEY}`) return { status: 401, body: { error: 'invalid_api_key', message: 'The API key is not valid' } };
      return { status: 200, body: { accessToken: 'secret-token', tokenType: 'Bearer', expiresIn: 900, scope: 'game:economy game:telemetry game:flags.read' } };
    }
    if (headers.authorization !== 'Bearer secret-token') return { status: 401, body: { error: 'unauthorized', message: 'no' } };
    const join = /^\/v1\/players\/(\d+)\/sessions$/.exec(path);
    if (join) {
      const userId = Number(join[1]);
      if (!balances.has(userId)) balances.set(userId, options.startBalance ?? 0);
      return { status: 200, body: { userId, balance: balances.get(userId) } };
    }
    const wallet = /^\/v1\/players\/(\d+)\/wallet$/.exec(path);
    if (wallet) return { status: 200, body: { userId: Number(wallet[1]), balance: balances.get(Number(wallet[1])) } };
    if (/^\/v1\/players\/\d+\/sessions\/end$/.test(path)) return { status: 204, body: null };
    if (path === '/v1/economy/transactions') {
      const key = headers['idempotency-key'] ?? '';
      const prior = byKey.get(key);
      if (prior) return { status: 200, body: { ...prior, replayed: true }, headers: { 'idempotent-replayed': 'true' } };
      const request = body as { kind: string; userId: number; amount?: number; itemId?: 'RedHat' | 'GoldCrown' };
      const amount = request.kind === 'earn' ? (request.amount ?? 0) : -DEMO_PRICES[request.itemId ?? 'RedHat'];
      const balance = (balances.get(request.userId) ?? 0) + amount;
      if (balance < 0) return { status: 422, body: { error: 'insufficient_funds', message: 'Not enough Coins' } };
      balances.set(request.userId, balance);
      const result = { transactionId: id(), kind: request.kind, userId: request.userId, amount, balanceAfter: balance, itemId: request.itemId ?? null, createdAt: 'now', replayed: false };
      byKey.set(key, result);
      if (request.itemId) unfulfilled.set(result.transactionId, { transactionId: result.transactionId, itemId: request.itemId, createdAt: 'now' });
      return { status: 201, body: result };
    }
    if (/^\/v1\/players\/\d+\/purchases$/.test(path.split('?')[0] ?? '')) return { status: 200, body: { purchases: [...unfulfilled.values()] } };
    const fulfilled = /^\/v1\/economy\/transactions\/([^/]+)\/fulfilled$/.exec(path);
    if (fulfilled) {
      unfulfilled.delete(fulfilled[1] ?? '');
      return { status: 204, body: null };
    }
    if (path === '/v1/flags') return { status: 200, body: { flags: { OrbSpawnMultiplier: 1, ShopEnabled: true, TelemetryEnabled: options.telemetryEnabled ?? true } } };
    if (path === '/v1/telemetry/batch') {
      const count = (body as { events: unknown[] }).events.length;
      return { status: 202, body: options.telemetryEnabled === false ? { accepted: 0, dropped: count } : { accepted: count, dropped: 0 } };
    }
    return { status: 404, body: { error: 'not_found', message: path } };
  };

  const fetch: FetchLike = async (url, init) => {
    const path = String(url).slice(BASE.length);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    seen.push(`${method} ${path}`);
    const real = answer(path, method, headers, body);
    const changed = options.tamper?.(path, method, real.status, (real.body ?? {}) as Record<string, unknown>) ?? real;
    return changed.body === null ? new Response(null, { status: changed.status }) : json(changed.status, changed.body, 'headers' in changed ? changed.headers : real.headers);
  };
  return { fetch, seen, balances };
}

const config = (overrides: Partial<DemoConfig> = {}): DemoConfig => ({ baseUrl: BASE, apiKey: KEY, userId: 4242, userIdSource: 'env', jaegerUrl: 'http://localhost:16686', ...overrides });

describe('runDemo', () => {
  test('walks the whole game contract and checks the answers', async () => {
    const backend = fakeBackend();
    const lines: string[] = [];
    const summary = await runDemo(config(), { fetch: backend.fetch, log: (line) => lines.push(line), runId: 'demo-test' });
    expect(summary).toEqual({ userId: 4242, startBalance: 0, endBalance: 5 });
    expect(backend.seen).toEqual([
      'POST /auth/service-token',
      'GET /v1/flags',
      'POST /v1/players/4242/sessions',
      'POST /v1/economy/transactions',
      'POST /v1/economy/transactions',
      'POST /v1/economy/transactions',
      'POST /v1/economy/transactions',
      'GET /v1/players/4242/wallet',
      'POST /v1/economy/transactions',
      'POST /v1/economy/transactions',
      'GET /v1/players/4242/purchases?unfulfilled=1',
      'POST /v1/economy/transactions/00000000-0000-4000-8000-000000000004/fulfilled',
      'GET /v1/players/4242/purchases?unfulfilled=1',
      'POST /v1/telemetry/batch',
      'POST /v1/players/4242/sessions/end',
    ]);
    expect(lines.every((line) => line.startsWith('ok   '))).toBe(true);
    expect(lines.join('\n')).not.toContain('secret-token');
    expect(lines.join('\n')).not.toContain(KEY);
    expect(lines.at(-1)).toContain('player 4242 leaves -> 204');
  });

  test('a rerun for the same player starts from the balance it finds', async () => {
    const backend = fakeBackend();
    const first = await runDemo(config(), { fetch: backend.fetch, log: () => undefined, runId: 'run-one' });
    const second = await runDemo(config(), { fetch: backend.fetch, log: () => undefined, runId: 'run-two' });
    expect(second).toEqual({ userId: 4242, startBalance: first.endBalance, endBalance: first.endBalance + 5 });
  });

  test('the crown a rich player buys must land on the right balance', async () => {
    const tamper: FakeOptions['tamper'] = (_p, _m, status, body) => (status === 201 && body.itemId === 'GoldCrown' ? { status, body: { ...body, balanceAfter: 0 } } : undefined);
    const backend = fakeBackend({ startBalance: 500, tamper });
    await expect(runDemo(config(), { fetch: backend.fetch, log: () => undefined, runId: 'rich-bad' })).rejects.toThrow(/buy the Gold Crown with 505 Coins: balanceAfter should be 405, got 0/);
  });

  test('the crown a rich player buys must be charged its catalog price', async () => {
    const tamper: FakeOptions['tamper'] = (_p, _m, status, body) => (status === 201 && body.itemId === 'GoldCrown' ? { status, body: { ...body, amount: -1 } } : undefined);
    const backend = fakeBackend({ startBalance: 500, tamper });
    await expect(runDemo(config(), { fetch: backend.fetch, log: () => undefined, runId: 'rich-price' })).rejects.toThrow(/buy the Gold Crown with 505 Coins: amount should be -100, got -1/);
  });

  test('a rich player buys the Gold Crown instead of being refused', async () => {
    const backend = fakeBackend({ startBalance: 500 });
    const lines: string[] = [];
    const summary = await runDemo(config(), { fetch: backend.fetch, log: (line) => lines.push(line), runId: 'rich' });
    expect(summary.endBalance).toBe(500 + 30 - 25 - 100);
    expect(lines.join('\n')).toContain('buy the Gold Crown with 505 Coins -> 201');
  });

  test('telemetry switched off by the flag is all dropped, and that is fine', async () => {
    const backend = fakeBackend({ telemetryEnabled: false });
    await expect(runDemo(config(), { fetch: backend.fetch, log: () => undefined, runId: 'quiet' })).resolves.toMatchObject({ endBalance: 5 });
  });

  test('a bad key fails on the exchange with the status, the code and a hint', async () => {
    const backend = fakeBackend();
    await expect(runDemo(config({ apiKey: `opk_game-server.${'b'.repeat(43)}` }), { fetch: backend.fetch, log: () => undefined, runId: 'bad' })).rejects.toThrow(
      'trade the game API key for a 15 minute scoped token: expected HTTP 200, got 401 invalid_api_key (The API key is not valid). Check that OUTPOST_GAME_API_KEY is the key the seed stored',
    );
    expect(backend.seen).toEqual(['POST /auth/service-token']);
  });

  const broken: Array<[label: string, tamper: NonNullable<FakeOptions['tamper']>, message: RegExp]> = [
    ['a replay that is not marked replayed', (path, _m, status, body) => (status === 200 && path === '/v1/economy/transactions' ? { status, body: { ...body, replayed: false } } : undefined), /replayed should be true/],
    ['a token of the wrong type', (path, _m, status, body) => (path === '/auth/service-token' && status === 200 ? { status, body: { ...body, tokenType: 'MAC' } } : undefined), /tokenType should be "Bearer", got "MAC"/],
    ['a flag value that is an object', (path, _m, status) => (path === '/v1/flags' ? { status, body: { flags: { ShopEnabled: true, OrbSpawnMultiplier: 1, TelemetryEnabled: true, Extra: {} } } } : undefined), /flag Extra has an unsupported value \{\}/],
    ['a join for another player', (path, _m, status, body) => (path.endsWith('/sessions') ? { status, body: { ...body, userId: 4243 } } : undefined), /userId should be 4242, got 4243/],
    ['a fresh earn marked replayed', (_p, _m, status, body) => (status === 201 && body.kind === 'earn' ? { status, body: { ...body, replayed: true } } : undefined), /earn batch 1, 10 Coins: replayed should be false, got true/],
    ['a replay with a different balance', (path, _m, status, body) => (status === 200 && path === '/v1/economy/transactions' ? { status, body: { ...body, balanceAfter: 31 } } : undefined), /replays and pays nothing: balanceAfter should be 30, got 31/],
    ['a hat with the wrong balance', (_p, _m, status, body) => (status === 201 && body.itemId === 'RedHat' ? { status, body: { ...body, balanceAfter: 999 } } : undefined), /buy the Red Hat, priced by the backend: balanceAfter should be 5, got 999/],
    ['an acknowledge that did nothing', (path, _m, status) => (path.includes('/purchases') ? { status, body: { purchases: [{ transactionId: '00000000-0000-4000-8000-000000000004', itemId: 'RedHat', createdAt: 'now' }] } } : undefined), /the next reconcile no longer lists it: should no longer list the Red Hat purchase/],
    ['telemetry that claims a drop', (path, _m, status) => (path === '/v1/telemetry/batch' ? { status, body: { accepted: 3, dropped: 1 } } : undefined), /dropped should be 0, got 1/],
    ['flags that are not an object', (path, _m, status) => (path === '/v1/flags' ? { status, body: { flags: [] } } : undefined), /flags should be an object, got \[\]/],
    ['an earn of another kind', (_p, _m, status, body) => (status === 201 && body.kind === 'earn' ? { status, body: { ...body, kind: 'refund' } } : undefined), /earn batch 1, 10 Coins: kind should be "earn", got "refund"/],
    ['an earn of another amount', (_p, _m, status, body) => (status === 201 && body.kind === 'earn' ? { status, body: { ...body, amount: 11 } } : undefined), /earn batch 1, 10 Coins: amount should be 10, got 11/],
    ['a hat answered as another item', (_p, _m, status, body) => (status === 201 && body.itemId === 'RedHat' ? { status, body: { ...body, itemId: 'GoldCrown' } } : undefined), /buy the Red Hat, priced by the backend: itemId should be "RedHat", got "GoldCrown"/],
    ['a purchase list that is not a list', (path, _m, status) => (path.includes('/purchases') ? { status, body: { purchases: null } } : undefined), /purchases should be a list, got null/],
    ['a replay without the Idempotent-Replayed header', (path, _m, status, body) => (status === 200 && path === '/v1/economy/transactions' ? { status, body, headers: {} } : undefined), /Idempotent-Replayed header should be "true"/],
    ['a replay with a new transaction id', (path, _m, status, body) => (status === 200 && path === '/v1/economy/transactions' ? { status, body: { ...body, transactionId: 'other' } } : undefined), /transactionId should be/],
    ['an earn with the wrong balanceAfter', (path, _m, status, body) => (status === 201 && body.kind === 'earn' && path === '/v1/economy/transactions' ? { status, body: { ...body, balanceAfter: 999 } } : undefined), /balanceAfter should be 10, got 999/],
    ['a purchase priced wrong', (path, _m, status, body) => (status === 201 && body.kind === 'purchase' ? { status, body: { ...body, amount: -1 } } : undefined), /amount should be -25, got -1/],
    ['a refusal with the wrong code', (_p, _m, status) => (status === 422 ? { status, body: { error: 'nope', message: 'x' } } : undefined), /error should be "insufficient_funds", got "nope"/],
    ['a wallet that paid the replay', (path, _m, status, body) => (path.endsWith('/wallet') ? { status, body: { ...body, balance: 40 } } : undefined), /balance should be 30, got 40/],
    ['a flag with the wrong type', (path, _m, status) => (path === '/v1/flags' ? { status, body: { flags: { ShopEnabled: 'yes', OrbSpawnMultiplier: 1, TelemetryEnabled: true } } } : undefined), /flag ShopEnabled should be a boolean, got "yes"/],
    ['telemetry that lost events', (path, _m, status) => (path === '/v1/telemetry/batch' ? { status, body: { accepted: 2, dropped: 0 } } : undefined), /accepted should be 3, got 2/],
    ['a reconcile that misses the hat', (path, _m, status) => (path.includes('/purchases') ? { status, body: { purchases: [] } } : undefined), /should list the Red Hat/],
    ['an unexpected status', (path) => (path.endsWith('/sessions/end') ? { status: 500, body: { error: 'internal', message: 'oops' } } : undefined), /player 4242 leaves: expected HTTP 204, got 500 internal \(oops\)/],
    ['a body that is not JSON', (path) => (path === '/v1/flags' ? { status: 502, body: '<html>' } : undefined), /read the flags, as a server does on boot: expected HTTP 200, got 502 <html>/],
  ];

  test.each(broken)('fails on %s', async (_label, tamper, message) => {
    const backend = fakeBackend({ tamper });
    await expect(runDemo(config(), { fetch: backend.fetch, log: () => undefined, runId: 'tamper' })).rejects.toThrow(message);
  });
});

describe('mainDemo', () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, log: (line: string) => out.push(line), error: (line: string) => err.push(line) };
  };

  test('exits 0 after a full run and points at Jaeger', async () => {
    const backend = fakeBackend();
    const time = fakeTime();
    const streams = io();
    const code = await mainDemo({ OUTPOST_GAME_API_KEY: KEY, OUTPOST_BACKEND_URL: BASE, OUTPOST_DEMO_USER_ID: '77' }, { fetch: backend.fetch, ...time, ...streams });
    expect(code).toBe(0);
    expect(streams.err).toEqual([]);
    expect(streams.out[0]).toBe('ok   backend is ready -> 200 {"status":"ready","checks":{"mysql":"ok","redis":"ok"}}');
    expect(streams.out.at(-1)).toBe('Done. Open http://localhost:16686, choose the outpost-backend service and the operation POST /v1/economy/transactions, then press Find Traces.');

    const remapped = io();
    await mainDemo({ OUTPOST_GAME_API_KEY: KEY, OUTPOST_BACKEND_URL: BASE, OUTPOST_JAEGER_URL: 'http://127.0.0.1:26686' }, { fetch: fakeBackend().fetch, ...fakeTime(), ...remapped });
    expect(remapped.out.at(-1)).toContain('Open http://127.0.0.1:26686,');
  });

  test('a key with a line break exits 1 and no part of it reaches either stream', async () => {
    const secret = 'FAKESECRETFAKESECRETFAKESECRETFAKE';
    const streams = io();
    const code = await mainDemo({ OUTPOST_GAME_API_KEY: `opk_game-server.${secret}\nTAILPART`, OUTPOST_BACKEND_URL: BASE }, { fetch: fakeBackend().fetch, ...fakeTime(), ...streams });
    expect(code).toBe(1);
    const all = [...streams.out, ...streams.err].join('\n');
    expect(all).toContain('OUTPOST_GAME_API_KEY is not a well-formed key');
    expect(all).not.toContain(secret);
    expect(all).not.toContain('TAILPART');
  });

  test('redacts the key and the access token from any error message', async () => {
    // A broken backend that echoes the caller's credentials in its error body.
    const echo: FetchLike = async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (url.endsWith('/readyz')) return json(200, { status: 'ready', checks: {} });
      if (url.endsWith('/auth/service-token')) return json(200, { accessToken: 'tok-SECRET-123456', tokenType: 'Bearer', expiresIn: 900, scope: 'game:economy' });
      return json(500, { error: 'internal', message: `saw ${headers.authorization ?? ''} and ${KEY}` });
    };
    const streams = io();
    expect(await mainDemo({ OUTPOST_GAME_API_KEY: KEY, OUTPOST_BACKEND_URL: BASE }, { fetch: echo, ...fakeTime(), ...streams })).toBe(1);
    const all = [...streams.out, ...streams.err].join('\n');
    expect(all).toContain('saw Bearer [redacted] and [redacted]');
    expect(all).not.toContain('tok-SECRET-123456');
    expect(all).not.toContain(KEY);
  });

  test('loads the env file inside the error handling, so a bad .env is one line', async () => {
    const streams = io();
    const loadEnv = () => {
      throw Object.assign(new Error('EISDIR: illegal operation on a directory, read'), { code: 'EISDIR' });
    };
    expect(await mainDemo({ OUTPOST_GAME_API_KEY: KEY }, { fetch: fakeBackend().fetch, ...fakeTime(), ...streams, loadEnv })).toBe(1);
    expect(streams.err).toEqual(['\ndemo failed: could not load the root .env (EISDIR: illegal operation on a directory, read)']);

    const loaded = io();
    const env: Record<string, string | undefined> = { OUTPOST_BACKEND_URL: BASE };
    const setKey = () => {
      env.OUTPOST_GAME_API_KEY = KEY;
    };
    expect(await mainDemo(env, { fetch: fakeBackend().fetch, ...fakeTime(), ...loaded, loadEnv: setKey })).toBe(0);
  });

  test('exits 1 with one clear line on a config error or a failed step, never printing the key', async () => {
    const streams = io();
    expect(await mainDemo({}, { fetch: fakeBackend().fetch, ...fakeTime(), ...streams })).toBe(1);
    expect(streams.err.join('\n')).toMatch(/demo failed: OUTPOST_GAME_API_KEY is not set/);

    const bad = io();
    const wrongKey = `opk_game-server.${'c'.repeat(43)}`;
    expect(await mainDemo({ OUTPOST_GAME_API_KEY: wrongKey, OUTPOST_BACKEND_URL: BASE }, { fetch: fakeBackend().fetch, ...fakeTime(), ...bad })).toBe(1);
    expect(bad.err.join('\n')).toMatch(/demo failed: trade the game API key .* got 401 invalid_api_key/);
    expect([...bad.out, ...bad.err].join('\n')).not.toContain(wrongKey);
  });
});
