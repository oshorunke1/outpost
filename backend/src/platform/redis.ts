import { Redis } from 'ioredis';

export type { Redis };

// Backoff once connected, in milliseconds: quick at first, never longer than two seconds.
export function reconnectDelay(attempt: number): number {
  return Math.min(attempt * 200, 2_000);
}

// No offline queue and one retry per command: when Redis is down, calls fail at once instead of
// piling up. That is what lets login fail closed quickly (ADR 0014). The first connect gives up
// after the timeout with an error that names Redis and never prints the URL. After that first
// connect works, the client redials with a capped backoff, so a Redis restart heals by itself.
export async function connectRedis(url: string, connectTimeoutMs = 2_000): Promise<Redis> {
  const redis = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: connectTimeoutMs,
    retryStrategy: () => null, // the first connect must fail fast, not redial forever
  });
  // ioredis reports the real reason (like ECONNREFUSED) on the error event, and connect() itself
  // only says the connection closed. Keep the last reason so the thrown message is useful.
  let lastReason = '';
  redis.on('error', (error: Error) => {
    lastReason = error.message;
  });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${connectTimeoutMs}ms`));
    }, connectTimeoutMs + 250);
  });
  try {
    await Promise.race([redis.connect(), deadline]);
  } catch (error) {
    redis.disconnect();
    const reason = lastReason || (error instanceof Error ? error.message : 'unknown error');
    throw new Error(`Redis is unreachable (${reason})`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
  redis.options.retryStrategy = reconnectDelay;
  return redis;
}
