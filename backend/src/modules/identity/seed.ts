import { randomBytes } from 'node:crypto';
import type { Clock } from '../../platform/clock.js';
import type { Db } from '../../platform/db.js';
import { parseApiKey } from './crypto/apiKey.js';
import type { PasswordHasher } from './crypto/password.js';
import { createMysqlOperatorRepo, normalizeEmail } from './repos/operatorRepo.js';
import { createMysqlServiceClientRepo } from './repos/serviceClientRepo.js';
import { GAME_SCOPES, OPERATOR_SCOPES } from './scopes.js';

export const GAME_CLIENT_ID = 'game-server';
// An allow list: an unset, misspelled or unknown NODE_ENV is refused, not treated as development.
const SEED_ENVIRONMENTS: readonly string[] = ['development', 'test'];

export interface SeedInput {
  db: Db;
  clock: Clock;
  hasher: PasswordHasher;
  // Passed in rather than read here, so tests can prove the refusal. The CLI passes process.env.NODE_ENV.
  nodeEnv: string | undefined;
  // A key the developer already has (OUTPOST_GAME_API_KEY, which setup:dev fills with a random value).
  // When given, its hash is stored on every run, so that key always works and nothing is printed.
  apiKey?: string | undefined;
  // Replace the game client's secret even if it already has one. Refused together with apiKey.
  rotate?: boolean;
  operatorEmail?: string | undefined;
  operatorPassword?: string | undefined;
}

export interface SeedResult {
  clientId: string;
  // The full key, only when this run made a new secret. It is never stored and cannot be shown again.
  apiKey: string | null;
  // Where the client's key came from on this run: the apiKey input, a new random secret, or left as it was.
  keySource: 'env' | 'generated' | 'existing';
  operatorEmail: string | null;
}

export function assertSeedAllowed(nodeEnv: string | undefined): void {
  if (nodeEnv === undefined || !SEED_ENVIRONMENTS.includes(nodeEnv)) {
    throw new Error(`seed only runs when NODE_ENV is development or test (got ${JSON.stringify(nodeEnv ?? null)})`);
  }
}

// Development and test only. With an apiKey (the dev .env key) it stores that key's hash on every
// run, so the key in .env always works. Without one it creates the game server's service client with
// a fresh random secret and hands back the full key once. Either way MySQL keeps only an Argon2id
// hash of the secret, and a run without an apiKey leaves an existing client alone unless rotate is
// set, so it is safe to run on every boot. It also creates or updates the dev operator when an email
// and password are given.
//
// This is not a way to provision or rotate production keys, and it refuses to run there. Production
// clients need their own provisioning command (planned, not built yet) that does the same thing
// against the production database under an operator's control.
export async function seedDev(input: SeedInput): Promise<SeedResult> {
  assertSeedAllowed(input.nodeEnv);
  // Everything about the input is checked before the first database write.
  const given = input.apiKey === undefined ? null : parseApiKey(input.apiKey);
  if (input.apiKey !== undefined && !given) throw new Error('OUTPOST_GAME_API_KEY must look like opk_<clientId>.<secret>');
  if (given && input.rotate) {
    throw new Error('--rotate makes a new random key, so it cannot be used while OUTPOST_GAME_API_KEY is set; unset it or change the key in .env');
  }

  const clients = createMysqlServiceClientRepo(input.db, input.clock);
  let clientId = GAME_CLIENT_ID;
  let apiKey: string | null = null;
  let keySource: SeedResult['keySource'] = 'existing';
  if (given) {
    clientId = given.clientId;
    keySource = 'env';
    await clients.upsert({ clientId, secretHash: await input.hasher.hash(given.secret), scopes: GAME_SCOPES });
  } else if (input.rotate || !(await clients.findById(GAME_CLIENT_ID))) {
    const secret = randomBytes(32).toString('base64url'); // 43 characters, 256 bits
    apiKey = `opk_${GAME_CLIENT_ID}.${secret}`;
    if (!parseApiKey(apiKey)) throw new Error('generated an API key that does not parse'); // cannot happen, but never store one
    keySource = 'generated';
    await clients.upsert({ clientId, secretHash: await input.hasher.hash(secret), scopes: GAME_SCOPES });
  }

  if (!input.operatorEmail || !input.operatorPassword) return { clientId, apiKey, keySource, operatorEmail: null };
  const operators = createMysqlOperatorRepo(input.db, input.clock);
  const passwordHash = await input.hasher.hash(input.operatorPassword);
  const existing = await operators.findByEmail(input.operatorEmail);
  if (existing) await operators.setPasswordHash(existing.id, passwordHash);
  else await operators.create({ email: input.operatorEmail, passwordHash, scopes: OPERATOR_SCOPES });
  return { clientId, apiKey, keySource, operatorEmail: normalizeEmail(input.operatorEmail) };
}
