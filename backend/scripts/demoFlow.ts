// The game-server simulator behind `pnpm demo`. It speaks only the HTTP contract in
// contracts/openapi.yaml, the same one the Roblox BackendClient uses, and imports nothing from src.
// Everything it needs from the outside (fetch, the clock, sleep, output) is passed in, so the unit
// tests drive it without a network.
import { randomBytes, randomInt } from 'node:crypto';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface DemoConfig {
  baseUrl: string;
  apiKey: string;
  userId: number;
  userIdSource: 'env' | 'random';
  // Only used for the closing hint that points at the traces.
  jaegerUrl: string;
}

// A mistake the demo explains in one line: bad settings, a backend that is not up, or an answer
// that breaks the contract. main prints the message and exits 1.
export class DemoError extends Error {
  override readonly name = 'DemoError';
}

// The prices the contract's catalog charges. The demo needs them to know what balance to expect,
// and a unit test keeps them equal to the backend catalog.
export const DEMO_PRICES = { RedHat: 25, GoldCrown: 100 } as const;

export const DEFAULT_BACKEND_URL = 'http://127.0.0.1:3000';
export const DEFAULT_JAEGER_URL = 'http://localhost:16686';
export const READY_TIMEOUT_MS = 60_000;
const FIRST_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;
const USER_ID = /^[1-9][0-9]{0,15}$/;
// The shape the backend accepts (identity/crypto/apiKey.ts): printable, no spaces or control characters.
const API_KEY = /^opk_[a-z0-9-]{3,40}\.[A-Za-z0-9_-]{32,128}$/;
const BAD_KEY = 'OUTPOST_GAME_API_KEY is not a well-formed key (expected opk_<clientId>.<secret>)';
const EARN_AMOUNT = 10;
const EARN_BATCHES = 3;

// 13 digit ids, far above any Roblox user id today, so a demo player never looks like a real one.
const randomDemoUserId = () => randomInt(1_000_000_000_000, 10_000_000_000_000);

export function readDemoConfig(env: Record<string, string | undefined>, randomUserId: () => number = randomDemoUserId): DemoConfig {
  const apiKey = env.OUTPOST_GAME_API_KEY;
  if (!apiKey) throw new DemoError('OUTPOST_GAME_API_KEY is not set. Run pnpm setup:dev first, or export the key the seed printed.');
  // Never echo the value: a key with a pasted line break is still mostly the real secret.
  if (!API_KEY.test(apiKey)) throw new DemoError(BAD_KEY);

  const baseUrl = readHttpUrl('OUTPOST_BACKEND_URL', env.OUTPOST_BACKEND_URL ?? DEFAULT_BACKEND_URL);
  const jaegerUrl = readHttpUrl('OUTPOST_JAEGER_URL', env.OUTPOST_JAEGER_URL ?? DEFAULT_JAEGER_URL);

  // Empty counts as unset, the way an env file line like OUTPOST_DEMO_USER_ID= is usually meant.
  const rawUserId = env.OUTPOST_DEMO_USER_ID;
  if (rawUserId === undefined || rawUserId === '') return { baseUrl, apiKey, userId: randomUserId(), userIdSource: 'random', jaegerUrl };
  const userId = Number(rawUserId);
  if (!USER_ID.test(rawUserId) || !Number.isSafeInteger(userId)) {
    throw new DemoError(`OUTPOST_DEMO_USER_ID must be a whole number from 1 to ${Number.MAX_SAFE_INTEGER} (got ${JSON.stringify(rawUserId)})`);
  }
  return { baseUrl, apiKey, userId, userIdSource: 'env', jaegerUrl };
}

// An http(s) origin plus an optional path, without the trailing slash. Credentials, a query or a
// fragment would break the joined paths, and credentials would end up in the error lines.
function readHttpUrl(name: string, raw: string): string {
  const url = URL.canParse(raw) ? new URL(raw) : null;
  if (url && (url.username || url.password)) throw new DemoError(`${name} must not carry a user name or password`);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.search || url.hash) {
    throw new DemoError(`${name} must be an http or https URL with no query or fragment (got ${JSON.stringify(raw)})`);
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

// fetch only says "fetch failed"; the useful part (ECONNREFUSED, ENOTFOUND, a timeout) is in its cause.
export function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause: unknown = error.cause;
  if (!(cause instanceof Error)) return error.message;
  const code = (cause as { code?: unknown }).code;
  let message = cause.message;
  if (!message && cause instanceof AggregateError) {
    const first: unknown = cause.errors[0];
    if (first instanceof Error) message = first.message;
  }
  if (typeof code === 'string') return `${code}: ${message || code}`;
  return message || error.message;
}

interface Reply {
  status: number;
  body: unknown;
  headers: Headers;
}

async function send(fetch: FetchLike, url: string, init: RequestInit, signal: AbortSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)): Promise<Reply> {
  const response = await fetch(url, { ...init, signal });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  return { status: response.status, body, headers: response.headers };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// "503 not_ready (mysql fail, redis ok)" or "401 invalid_api_key (The API key is not valid)".
function describeReply(reply: Reply): string {
  const body = reply.body;
  if (isRecord(body) && typeof body.error === 'string') return `${reply.status} ${body.error} (${String(body.message)})`;
  if (isRecord(body) && typeof body.status === 'string' && isRecord(body.checks)) {
    const checks = Object.entries(body.checks).map(([name, state]) => `${name} ${String(state)}`);
    return `${reply.status} ${body.status} (${checks.join(', ')})`;
  }
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return `${reply.status} ${text.slice(0, 200)}`;
}

function okLine(step: string, status: number, shown?: unknown): string {
  return `ok   ${step} -> ${status}${shown === undefined ? '' : ` ${JSON.stringify(shown)}`}`;
}

export interface ReadyOptions {
  baseUrl: string;
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  timeoutMs?: number;
  // Makes the abort signal for one request; tests pass a recorder.
  requestTimeout?: (ms: number) => AbortSignal;
}

// Polls /readyz with a doubling backoff (capped at 5 s) until it answers ready or the time is up.
// The deadline is hard: a request never gets longer than the time that is left.
export async function waitForReady(options: ReadyOptions): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? READY_TIMEOUT_MS;
  const deadline = options.now() + timeoutMs;
  let delay = FIRST_BACKOFF_MS;
  const requestTimeout = options.requestTimeout ?? ((ms: number) => AbortSignal.timeout(ms));
  let last = 'no answer yet';
  for (;;) {
    const left = deadline - options.now();
    if (left <= 0) throw new DemoError(`the backend at ${options.baseUrl} was not ready within ${timeoutMs / 1000}s; last ${last}`);
    try {
      const reply = await send(options.fetch, `${options.baseUrl}/readyz`, { method: 'GET' }, requestTimeout(Math.min(REQUEST_TIMEOUT_MS, left)));
      if (reply.status === 200 && isRecord(reply.body) && reply.body.status === 'ready') return reply.body;
      last = `answer HTTP ${describeReply(reply)}`;
    } catch (error) {
      last = `error ${describeFetchError(error)}. Is the stack up? Try docker compose up -d --build --wait`;
    }
    const remaining = deadline - options.now();
    if (remaining > 0) await options.sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 2, MAX_BACKOFF_MS);
  }
}

export interface RunDeps {
  fetch: FetchLike;
  log: (line: string) => void;
  // Told about the access token as soon as it exists, so the caller can keep it out of errors.
  onSecret?: (secret: string) => void;
  runId?: string;
  now?: () => number;
}

export interface DemoSummary {
  userId: number;
  startBalance: number;
  endBalance: number;
}

interface CallOptions {
  token?: string;
  apiKey?: string;
  idempotencyKey?: string;
  body?: unknown;
}

function field(body: unknown, name: string): unknown {
  return isRecord(body) ? body[name] : undefined;
}

function expectField(step: string, body: unknown, name: string, wanted: unknown): void {
  const actual = field(body, name);
  if (actual !== wanted) throw new DemoError(`${step}: ${name} should be ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
}

function numberField(step: string, body: unknown, name: string): number {
  const actual = field(body, name);
  if (typeof actual !== 'number' || !Number.isSafeInteger(actual)) {
    throw new DemoError(`${step}: ${name} should be a whole number, got ${JSON.stringify(actual)}`);
  }
  return actual;
}

function stringField(step: string, body: unknown, name: string): string {
  const actual = field(body, name);
  if (typeof actual !== 'string' || actual === '') throw new DemoError(`${step}: ${name} should be a non-empty string, got ${JSON.stringify(actual)}`);
  return actual;
}

const FLAG_TYPES = { ShopEnabled: 'boolean', OrbSpawnMultiplier: 'number', TelemetryEnabled: 'boolean' } as const;

// One game server's life with one player: token, flags, join, earn, a replayed retry, a purchase, a
// refused (or affordable) purchase, the reconcile on join, telemetry and leave. Every answer is
// checked against the contract and the balance it should produce. The balance is read on join, so
// a rerun for the same player never fails because of earlier runs.
export async function runDemo(config: DemoConfig, deps: RunDeps): Promise<DemoSummary> {
  const { userId } = config;
  const run = deps.runId ?? `demo-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const now = deps.now ?? Date.now;

  async function step(name: string, method: string, path: string, wanted: number, options: CallOptions = {}): Promise<Reply> {
    const headers: Record<string, string> = {};
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.apiKey) headers.authorization = `ApiKey ${options.apiKey}`;
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    let reply: Reply;
    try {
      reply = await send(deps.fetch, `${config.baseUrl}${path}`, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch (error) {
      throw new DemoError(`${name}: ${describeFetchError(error)}`);
    }
    if (reply.status !== wanted) {
      const hint =
        path === '/auth/service-token' && reply.status === 401
          ? '. Check that OUTPOST_GAME_API_KEY is the key the seed stored (pnpm setup:dev writes it to .env and the migrate service stores it)'
          : '';
      throw new DemoError(`${name}: expected HTTP ${wanted}, got ${describeReply(reply)}${hint}`);
    }
    return reply;
  }

  const grantStep = 'trade the game API key for a 15 minute scoped token';
  const grant = await step(grantStep, 'POST', '/auth/service-token', 200, { apiKey: config.apiKey });
  expectField(grantStep, grant.body, 'tokenType', 'Bearer');
  const token = stringField(grantStep, grant.body, 'accessToken');
  deps.onSecret?.(token);
  // Never print the token itself.
  deps.log(okLine(grantStep, grant.status, { scope: field(grant.body, 'scope'), expiresIn: field(grant.body, 'expiresIn') }));

  const flagsStep = 'read the flags, as a server does on boot';
  const flagsReply = await step(flagsStep, 'GET', '/v1/flags', 200, { token });
  const flags = field(flagsReply.body, 'flags');
  if (!isRecord(flags)) throw new DemoError(`${flagsStep}: flags should be an object, got ${JSON.stringify(flags)}`);
  for (const [name, value] of Object.entries(flags)) {
    if (!['boolean', 'number', 'string'].includes(typeof value)) throw new DemoError(`${flagsStep}: flag ${name} has an unsupported value ${JSON.stringify(value)}`);
  }
  for (const [name, type] of Object.entries(FLAG_TYPES)) {
    if (typeof flags[name] !== type) throw new DemoError(`${flagsStep}: flag ${name} should be a ${type}, got ${JSON.stringify(flags[name])}`);
  }
  deps.log(okLine(flagsStep, flagsReply.status, flags));

  const joinStep = `player ${userId} joins`;
  const joined = await step(joinStep, 'POST', `/v1/players/${userId}/sessions`, 200, { token, body: {} });
  expectField(joinStep, joined.body, 'userId', userId);
  const startBalance = numberField(joinStep, joined.body, 'balance');
  deps.log(okLine(joinStep, joined.status, { balance: startBalance }));

  let balance = startBalance;
  const earnBody = { kind: 'earn', userId, amount: EARN_AMOUNT, reason: 'orbs' };
  let lastEarn: unknown = null;
  for (let batch = 1; batch <= EARN_BATCHES; batch += 1) {
    const name = `earn batch ${batch}, ${EARN_AMOUNT} Coins`;
    const earned = await step(name, 'POST', '/v1/economy/transactions', 201, { token, idempotencyKey: `${run}:${userId}:${batch}`, body: earnBody });
    balance += EARN_AMOUNT;
    expectField(name, earned.body, 'kind', 'earn');
    expectField(name, earned.body, 'amount', EARN_AMOUNT);
    expectField(name, earned.body, 'replayed', false);
    expectField(name, earned.body, 'balanceAfter', balance);
    lastEarn = earned.body;
    deps.log(okLine(name, earned.status, { balanceAfter: balance }));
  }

  const replayStep = `retry batch ${EARN_BATCHES} with the same key, which replays and pays nothing`;
  const replay = await step(replayStep, 'POST', '/v1/economy/transactions', 200, { token, idempotencyKey: `${run}:${userId}:${EARN_BATCHES}`, body: earnBody });
  expectField(replayStep, replay.body, 'replayed', true);
  expectField(replayStep, replay.body, 'transactionId', field(lastEarn, 'transactionId'));
  expectField(replayStep, replay.body, 'balanceAfter', balance);
  if (replay.headers.get('idempotent-replayed') !== 'true') throw new DemoError(`${replayStep}: the Idempotent-Replayed header should be "true"`);
  deps.log(okLine(replayStep, replay.status, { replayed: true, balanceAfter: balance }));

  const walletStep = 'the wallet shows the replay paid nothing';
  const wallet = await step(walletStep, 'GET', `/v1/players/${userId}/wallet`, 200, { token });
  expectField(walletStep, wallet.body, 'balance', balance);
  deps.log(okLine(walletStep, wallet.status, { balance }));

  const hatStep = 'buy the Red Hat, priced by the backend';
  const hat = await step(hatStep, 'POST', '/v1/economy/transactions', 201, { token, idempotencyKey: `${run}:${userId}:hat`, body: { kind: 'purchase', userId, itemId: 'RedHat' } });
  balance -= DEMO_PRICES.RedHat;
  expectField(hatStep, hat.body, 'itemId', 'RedHat');
  expectField(hatStep, hat.body, 'amount', -DEMO_PRICES.RedHat);
  expectField(hatStep, hat.body, 'balanceAfter', balance);
  const hatId = stringField(hatStep, hat.body, 'transactionId');
  deps.log(okLine(hatStep, hat.status, { itemId: 'RedHat', amount: -DEMO_PRICES.RedHat, balanceAfter: balance }));

  // A fresh player always has too little for the crown. A player reused through
  // OUTPOST_DEMO_USER_ID may have saved up over many runs, and then the purchase simply succeeds.
  const crownBody = { kind: 'purchase', userId, itemId: 'GoldCrown' };
  const crownKey = `${run}:${userId}:crown`;
  if (balance < DEMO_PRICES.GoldCrown) {
    const crownStep = `try the Gold Crown with ${balance} Coins, which is refused`;
    const refused = await step(crownStep, 'POST', '/v1/economy/transactions', 422, { token, idempotencyKey: crownKey, body: crownBody });
    expectField(crownStep, refused.body, 'error', 'insufficient_funds');
    deps.log(okLine(crownStep, refused.status, { error: 'insufficient_funds' }));
  } else {
    const crownStep = `buy the Gold Crown with ${balance} Coins`;
    const crown = await step(crownStep, 'POST', '/v1/economy/transactions', 201, { token, idempotencyKey: crownKey, body: crownBody });
    balance -= DEMO_PRICES.GoldCrown;
    expectField(crownStep, crown.body, 'amount', -DEMO_PRICES.GoldCrown);
    expectField(crownStep, crown.body, 'balanceAfter', balance);
    deps.log(okLine(crownStep, crown.status, { itemId: 'GoldCrown', balanceAfter: balance }));
  }

  const listHat = async (name: string): Promise<{ status: number; listed: boolean; count: number }> => {
    const reply = await step(name, 'GET', `/v1/players/${userId}/purchases?unfulfilled=1`, 200, { token });
    const purchases = field(reply.body, 'purchases');
    if (!Array.isArray(purchases)) throw new DemoError(`${name}: purchases should be a list, got ${JSON.stringify(purchases)}`);
    const listed = purchases.some((purchase) => isRecord(purchase) && purchase.transactionId === hatId && purchase.itemId === 'RedHat');
    return { status: reply.status, listed, count: purchases.length };
  };
  const reconcileStep = 'reconcile on join finds the unacknowledged hat';
  const before = await listHat(reconcileStep);
  if (!before.listed) throw new DemoError(`${reconcileStep}: should list the Red Hat purchase ${hatId}`);
  deps.log(okLine(reconcileStep, before.status, { unfulfilled: before.count }));

  const ackStep = 'acknowledge the hat after granting it';
  const ack = await step(ackStep, 'POST', `/v1/economy/transactions/${hatId}/fulfilled`, 204, { token, body: {} });
  deps.log(okLine(ackStep, ack.status));
  const afterStep = 'the next reconcile no longer lists it';
  const after = await listHat(afterStep);
  if (after.listed) throw new DemoError(`${afterStep}: should no longer list the Red Hat purchase ${hatId}`);
  deps.log(okLine(afterStep, after.status, { unfulfilled: after.count }));

  const sentAt = now();
  const events = [
    { name: 'player_join', ts: sentAt, userId },
    { name: 'orb_collected', ts: sentAt, userId, value: 5 },
    { name: 'purchase_result', ts: sentAt, userId, dims: { outcome: 'Granted', itemId: 'RedHat' } },
  ];
  const telemetryStep = 'send a telemetry batch';
  const telemetry = await step(telemetryStep, 'POST', '/v1/telemetry/batch', 202, { token, body: { events } });
  // TelemetryEnabled off means the backend drops the whole batch on purpose.
  const accepted = flags.TelemetryEnabled === false ? 0 : events.length;
  expectField(telemetryStep, telemetry.body, 'accepted', accepted);
  expectField(telemetryStep, telemetry.body, 'dropped', events.length - accepted);
  deps.log(okLine(telemetryStep, telemetry.status, telemetry.body));

  const leaveStep = `player ${userId} leaves`;
  const left = await step(leaveStep, 'POST', `/v1/players/${userId}/sessions/end`, 204, { token, body: {} });
  deps.log(okLine(leaveStep, left.status));

  return { userId, startBalance, endBalance: balance };
}

export interface MainDeps {
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
  error: (line: string) => void;
  // Loads the root .env into env. Runs inside the error handling, so a bad file is one line too.
  loadEnv?: () => void;
}

// Replaces every secret, and every long piece of one, with [redacted]. The pieces matter when the
// value was mangled (a pasted line break) and only part of it shows up in a message.
function redact(message: string, secrets: Iterable<string>): string {
  let out = message;
  for (const secret of secrets) {
    const pieces = [secret, ...secret.split(/[\s.]+/).filter((piece) => piece.length >= 8)];
    for (const piece of pieces.sort((a, b) => b.length - a.length)) out = out.split(piece).join('[redacted]');
  }
  return out;
}

// Returns the exit code: 0 after a full run, 1 with one clear line on anything else. The key and
// the access token never reach either stream, whatever the error says.
export async function mainDemo(env: Record<string, string | undefined>, deps: MainDeps): Promise<number> {
  const secrets = new Set<string>();
  try {
    try {
      deps.loadEnv?.();
    } catch (error) {
      throw new DemoError(`could not load the root .env (${error instanceof Error ? error.message : String(error)})`);
    }
    if (env.OUTPOST_GAME_API_KEY) secrets.add(env.OUTPOST_GAME_API_KEY);
    const config = readDemoConfig(env);
    const ready = await waitForReady({ baseUrl: config.baseUrl, fetch: deps.fetch, sleep: deps.sleep, now: deps.now });
    deps.log(okLine('backend is ready', 200, ready));
    await runDemo(config, { fetch: deps.fetch, log: deps.log, onSecret: (secret) => secrets.add(secret) });
    deps.log('');
    deps.log(`Done. Open ${config.jaegerUrl}, choose the outpost-backend service and the operation POST /v1/economy/transactions, then press Find Traces.`);
    return 0;
  } catch (error) {
    deps.error(redact(`\ndemo failed: ${error instanceof Error ? error.message : String(error)}`, secrets));
    return 1;
  }
}
