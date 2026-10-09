import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Locally, TEST_MYSQL_URL and TEST_REDIS_URL come from the root .env (pnpm setup:dev).
// In CI they come from the workflow, and loadEnvFile never overrides variables that are already set.
const rootEnv = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false, // the files share one Redis database
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
