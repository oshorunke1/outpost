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
  // Replace the game client's secret even if it already has one.
  rotate?: boolean;
  operatorEmail?: string | undefined;
  operatorPassword?: string | undefined;
}

export interface SeedResult {
  clientId: string;
  // The full key, only when this run made a new secret. It is never stored and cannot be shown again.
  apiKey: string | null;
  operatorEmail: string | null;
}

export function assertSeedAllowed(nodeEnv: string | undefined): void {
  if (nodeEnv === undefined || !SEED_ENVIRONMENTS.includes(nodeEnv)) {
    throw new Error(`seed only runs when NODE_ENV is development or test (got ${JSON.stringify(nodeEnv ?? null)})`);
  }
}

// Development and test only. Creates the game server's service client with a fresh random secret
// and hands back the full key once; MySQL keeps only an Argon2id hash of the secret. Running it again
// leaves an existing client alone unless rotate is set, so it is safe to run on every boot. It also
// creates or updates the dev operator when an email and password are given.
//
// This is not a way to provision or rotate production keys, and it refuses to run there. Production
// clients need their own provisioning command (planned, not built yet) that does the same thing
// against the production database under an operator's control.
export async function seedDev(input: SeedInput): Promise<SeedResult> {
  assertSeedAllowed(input.nodeEnv);
  const clients = createMysqlServiceClientRepo(input.db, input.clock);
  let apiKey: string | null = null;
  if (input.rotate || !(await clients.findById(GAME_CLIENT_ID))) {
    const secret = randomBytes(32).toString('base64url'); // 43 characters, 256 bits
    apiKey = `opk_${GAME_CLIENT_ID}.${secret}`;
    if (!parseApiKey(apiKey)) throw new Error('generated an API key that does not parse'); // cannot happen, but never store one
    await clients.upsert({ clientId: GAME_CLIENT_ID, secretHash: await input.hasher.hash(secret), scopes: GAME_SCOPES });
  }

  if (!input.operatorEmail || !input.operatorPassword) return { clientId: GAME_CLIENT_ID, apiKey, operatorEmail: null };
  const operators = createMysqlOperatorRepo(input.db, input.clock);
  const passwordHash = await input.hasher.hash(input.operatorPassword);
  const existing = await operators.findByEmail(input.operatorEmail);
  if (existing) await operators.setPasswordHash(existing.id, passwordHash);
  else await operators.create({ email: input.operatorEmail, passwordHash, scopes: OPERATOR_SCOPES });
  return { clientId: GAME_CLIENT_ID, apiKey, operatorEmail: normalizeEmail(input.operatorEmail) };
}
