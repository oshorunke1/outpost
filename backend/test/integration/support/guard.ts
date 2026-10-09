// The harness creates and drops databases and flushes Redis, so it must only ever touch a local
// throwaway stack. These checks refuse anything else before a single command is sent.
export const TEST_REDIS_DB = 15;

export function assertTestRedisDb(redis: { options: { db?: number | undefined } }): void {
  const index = redis.options.db ?? 0;
  if (index !== TEST_REDIS_DB) {
    throw new Error(`refusing to flush Redis db ${index}, integration tests only run on db ${TEST_REDIS_DB} (set TEST_REDIS_URL to end in /${TEST_REDIS_DB})`);
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function parse(name: string, value: string): URL {
  try {
    const url = new URL(value);
    if (!LOOPBACK.has(url.hostname)) {
      throw new Error(`${name} must point at a loopback host (127.0.0.1, localhost or ::1), got ${url.hostname}`);
    }
    return url;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(name)) throw error;
    throw new Error(`${name} is not a valid URL`, { cause: error });
  }
}

// TEST_MYSQL_URL is the bare server (the harness picks the database name), and both URLs are local.
export function assertSafeTestUrls(mysqlUrl: string, redisUrl: string): void {
  const mysql = parse('TEST_MYSQL_URL', mysqlUrl);
  if (mysql.pathname !== '' && mysql.pathname !== '/') {
    throw new Error('TEST_MYSQL_URL must be a bare server URL with no database name, the harness creates its own');
  }
  parse('TEST_REDIS_URL', redisUrl);
}
