import { buildApp } from '../../../src/app.js';
import type { AppDeps } from '../../../src/app.js';
import { createAppDeps } from '../../../src/compose.js';
import type { ComposeLogger } from '../../../src/compose.js';
import { MEMORY_CONFIG } from '../../../src/memoryDeps.js';
import { FAST_ARGON2, createArgon2Hasher } from '../../../src/modules/identity/crypto/password.js';
import { createMysqlOperatorRepo } from '../../../src/modules/identity/repos/operatorRepo.js';
import type { Operator } from '../../../src/modules/identity/repos/operatorRepo.js';
import { OPERATOR_SCOPES } from '../../../src/modules/identity/scopes.js';
import { systemClock } from '../../../src/platform/clock.js';
import type { Db } from '../../../src/platform/db.js';
import type { ZodApp } from '../../../src/platform/http.js';
import { createMetrics } from '../../../src/platform/metrics.js';
import type { Redis } from '../../../src/platform/redis.js';
import type { IntegrationContext } from './context.js';

// The real composition root against the test containers, with cheap Argon2 settings.
export async function createIntegrationApp(
  ctx: IntegrationContext,
  overrides: { redis?: Redis; db?: Db; logger?: ComposeLogger } = {},
): Promise<{ app: ZodApp; deps: AppDeps }> {
  const deps = await createAppDeps(
    { ...MEMORY_CONFIG, databaseUrl: ctx.databaseUrl },
    { db: overrides.db ?? ctx.db, redis: overrides.redis ?? ctx.redis, clock: systemClock, metrics: createMetrics() },
    { argon2: FAST_ARGON2, ...(overrides.logger ? { logger: overrides.logger } : {}) },
  );
  return { app: await buildApp(deps), deps };
}

export async function seedOperator(ctx: IntegrationContext, email: string, password: string): Promise<Operator> {
  const hasher = createArgon2Hasher(FAST_ARGON2);
  return createMysqlOperatorRepo(ctx.db, systemClock).create({ email, passwordHash: await hasher.hash(password), scopes: OPERATOR_SCOPES });
}
