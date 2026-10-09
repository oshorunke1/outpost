import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createIntegrationContext } from './support/context.js';
import type { IntegrationContext } from './support/context.js';

describe('Redis client after a drop', () => {
  let ctx: IntegrationContext;
  beforeAll(async () => {
    ctx = await createIntegrationContext();
  });
  afterAll(async () => {
    await ctx.close();
  });

  test('redials with a backoff and commands work again', async () => {
    await expect(ctx.redis.ping()).resolves.toBe('PONG');
    ctx.redis.disconnect(true); // drop the socket and ask the client to reconnect
    const deadline = Date.now() + 5_000;
    let answer = '';
    while (answer !== 'PONG' && Date.now() < deadline) {
      answer = await ctx.redis.ping().catch(() => ''); // fails fast while it is down
      if (answer !== 'PONG') await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(answer).toBe('PONG');
  });

  test('a server side CLIENT KILL heals too', async () => {
    await ctx.redis.call('CLIENT', 'KILL', 'TYPE', 'normal', 'SKIPME', 'no').catch(() => undefined);
    const deadline = Date.now() + 5_000;
    let answer = '';
    while (answer !== 'PONG' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      answer = await ctx.redis.ping().catch(() => '');
    }
    expect(answer).toBe('PONG');
  });
});
