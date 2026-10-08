import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { STREAM_KEY, createRedisTelemetryProducer } from '../../src/modules/telemetry/producer.js';
import { createIntegrationContext } from './support/context.js';
import type { IntegrationContext } from './support/context.js';

describe('telemetry producer on Redis', () => {
  let ctx: IntegrationContext;
  beforeAll(async () => {
    ctx = await createIntegrationContext();
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await ctx.redis.del(STREAM_KEY);
  });

  test('each event becomes one stream entry with the event and its source', async () => {
    const ts = Date.now();
    await createRedisTelemetryProducer(ctx.redis).publish('game-server', [
      { name: 'player_join', ts, userId: 1001 },
      { name: 'player_leave', ts, userId: 1001 },
    ]);
    expect(await ctx.redis.xlen(STREAM_KEY)).toBe(2);
    const entries = await ctx.redis.xrange(STREAM_KEY, '-', '+');
    expect(entries.map(([, fields]) => fields)).toEqual([
      ['e', JSON.stringify({ name: 'player_join', ts, userId: 1001 }), 's', 'game-server'],
      ['e', JSON.stringify({ name: 'player_leave', ts, userId: 1001 }), 's', 'game-server'],
    ]);
  });

  test('an empty publish writes nothing', async () => {
    await createRedisTelemetryProducer(ctx.redis).publish('game-server', []);
    expect(await ctx.redis.exists(STREAM_KEY)).toBe(0);
  });

  test('a failed XADD rejects, so the route can answer 503', async () => {
    await ctx.redis.set(STREAM_KEY, 'not a stream'); // WRONGTYPE for every XADD
    await expect(createRedisTelemetryProducer(ctx.redis).publish('game-server', [{ name: 'player_join', ts: Date.now() }])).rejects.toThrow(/WRONGTYPE/);
  });
});
