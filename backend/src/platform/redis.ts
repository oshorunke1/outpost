import { Redis } from 'ioredis';

export type { Redis };

// No offline queue and one retry per command: when Redis is down, calls fail at once instead of
// piling up. That is what lets login fail closed quickly (ADR 0014). The connect itself gives up
// after the timeout with an error that names Redis and never prints the URL.
export async function connectRedis(url: string, connectTimeoutMs = 2_000): Promise<Redis> {
  const redis = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: connectTimeoutMs,
    retryStrategy: () => null, // do not keep redialing a dead server in the background
  });
  // ioredis reports the real reason (like ECONNREFUSED) on the error event, and connect() itself
  // only says the connection closed. Keep the last reason so the thrown message is useful.
  let lastReason = '';
  redis.on('error', (error: Error) => {
    lastReason = error.message;
  });
  try {
    await redis.connect();
  } catch (error) {
    redis.disconnect();
    const reason = lastReason || (error instanceof Error ? error.message : 'unknown error');
    throw new Error(`Redis is unreachable (${reason})`, { cause: error });
  }
  return redis;
}
