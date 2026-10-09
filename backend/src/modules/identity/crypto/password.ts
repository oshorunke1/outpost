import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  /** Resolves false for a wrong password AND for a stored value that is not a valid hash. It never throws. */
  verify(stored: string, plain: string): Promise<boolean>;
}

export interface Argon2Params {
  memoryCost: number; // KiB
  timeCost: number;
  parallelism: number;
}

// OWASP's minimum for Argon2id (m=19 MiB, t=2, p=1). Argon2id is @node-rs/argon2's default algorithm.
export const PRODUCTION_ARGON2: Argon2Params = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };
// Cheap settings for tests and the in-memory wiring. compose.ts never uses them.
export const FAST_ARGON2: Argon2Params = { memoryCost: 1_024, timeCost: 1, parallelism: 1 };

export function createArgon2Hasher(params: Argon2Params = PRODUCTION_ARGON2): PasswordHasher {
  return {
    hash: (plain) => hash(plain, params),
    async verify(stored, plain) {
      try {
        return await verify(stored, plain);
      } catch {
        // A malformed stored hash is treated as "does not match". Callers get one boolean either way,
        // so a corrupt row can never crash a login or leak through a distinct error.
        return false;
      }
    },
  };
}

// A real hash of a random password nobody knows. Login verifies against it when the email is
// unknown, so an unknown email costs the same time as a wrong password and cannot be told apart.
export async function makeDummyHash(hasher: PasswordHasher): Promise<string> {
  return hasher.hash(randomBytes(16).toString('hex'));
}
