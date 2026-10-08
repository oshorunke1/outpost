// Seeds the dev game client and operator. Development and test only (NODE_ENV must say so).
// A new game client key is printed to stdout exactly once; only its hash is stored, so copy it then.
// Pass --rotate to replace an existing key. Nothing else is ever printed that holds a secret.
import { createArgon2Hasher } from '../modules/identity/crypto/password.js';
import { assertSeedAllowed, seedDev } from '../modules/identity/seed.js';
import { systemClock } from '../platform/clock.js';
import { createPool } from '../platform/db.js';

try {
  assertSeedAllowed(process.env.NODE_ENV);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL must be set');
  process.exit(1);
}

const db = createPool(url, { connectionLimit: 2 });
try {
  const result = await seedDev({
    db,
    clock: systemClock,
    hasher: createArgon2Hasher(),
    nodeEnv: process.env.NODE_ENV,
    rotate: process.argv.includes('--rotate'),
    operatorEmail: process.env.OUTPOST_DEV_OPERATOR_EMAIL,
    operatorPassword: process.env.OUTPOST_DEV_OPERATOR_PASSWORD,
  });
  if (result.apiKey) {
    console.log(`new key for service client ${result.clientId}, shown once (only its hash is stored):`);
    console.log(`OUTPOST_GAME_API_KEY=${result.apiKey}`);
  } else {
    console.log(`service client ${result.clientId} already exists, key unchanged (run with --rotate for a new one)`);
  }
  if (result.operatorEmail) console.log(`seeded operator ${result.operatorEmail}`);
} finally {
  await db.end();
}
