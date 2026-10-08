// The harness flushes Redis between files, so it must only ever do that on the test database.
export const TEST_REDIS_DB = 15;

export function assertTestRedisDb(redis: { options: { db?: number | undefined } }): void {
  const index = redis.options.db ?? 0;
  if (index !== TEST_REDIS_DB) {
    throw new Error(`refusing to flush Redis db ${index}, integration tests only run on db ${TEST_REDIS_DB} (set TEST_REDIS_URL to end in /${TEST_REDIS_DB})`);
  }
}
