import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { createRedisIdentityStores } from '../../src/modules/identity/stores/redisStores.js';
import { describeIdentityStoreContract } from '../support/identityStoreContract.js';
import { createIntegrationContext } from './support/context.js';

describeIdentityStoreContract('redis', async () => {
  const ctx = await createIntegrationContext();
  return { stores: createRedisIdentityStores(ctx.redis), teardown: () => ctx.close() };
});

test('redis keeps only hashes, and superseded hashes live exactly as long as their family', async () => {
  const ctx = await createIntegrationContext();
  try {
    const stores = createRedisIdentityStores(ctx.redis);
    const familyId = randomUUID();
    await stores.refresh.create({ familyId, sessionId: randomUUID(), operatorId: randomUUID(), tokenVersion: 1, currentHash: 'h0' }, 3600);
    await stores.refresh.rotate(familyId, 'h0', 'h1');
    const familyTtl = await ctx.redis.pttl(`refresh:{${familyId}}`);
    const supersededTtl = await ctx.redis.pttl(`refresh:{${familyId}}:superseded`);
    expect(familyTtl).toBeGreaterThan(3_590_000);
    expect(supersededTtl).toBeGreaterThan(0);
    expect(supersededTtl).toBeLessThanOrEqual(familyTtl);
    expect(familyTtl - supersededTtl).toBeLessThan(1_000);
    await expect(ctx.redis.lrange(`refresh:{${familyId}}:superseded`, 0, -1)).resolves.toEqual(['h0']);
  } finally {
    await ctx.close();
  }
});

test('a Redis error is passed up from every store call, never read as empty', async () => {
  const ctx = await createIntegrationContext();
  const stores = createRedisIdentityStores(ctx.redis);
  ctx.redis.disconnect(); // no offline queue, so every command now fails at once
  try {
    await expect(stores.sessions.get(randomUUID())).rejects.toThrow();
    await expect(stores.refresh.get(randomUUID())).rejects.toThrow();
    await expect(stores.refresh.rotate(randomUUID(), 'a', 'b')).rejects.toThrow();
  } finally {
    await ctx.close().catch(() => undefined);
  }
});

// logoutAll lists the sessions, then deletes them. A login that lands in between must stay in the
// operator's index, or it would vanish from the session list and dodge the next logoutAll.
test('deleteAllForOperator keeps a session created while it runs in the index', async () => {
  const ctx = await createIntegrationContext();
  try {
    const real = createRedisIdentityStores(ctx.redis);
    const operatorId = randomUUID();
    const record = (sessionId: string) => ({ sessionId, operatorId, familyId: randomUUID(), createdAt: 1, userAgent: 'ua', ip: '10.0.0.1' });
    const early = record(randomUUID());
    const late = record(randomUUID());
    await real.sessions.create(early, 3600);
    // A client whose SMEMBERS reply is followed by a concurrent login before the delete runs.
    const racing = new Proxy(ctx.redis, {
      get(target, property, receiver) {
        if (property === 'smembers') {
          return async (key: string) => {
            const ids = await target.smembers(key);
            await real.sessions.create(late, 3600);
            return ids;
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const ended = await createRedisIdentityStores(racing).sessions.deleteAllForOperator(operatorId);
    expect(ended.map((s) => s.sessionId)).toEqual([early.sessionId]);
    await expect(ctx.redis.smembers(`user:${operatorId}:sessions`)).resolves.toEqual([late.sessionId]);
    await expect(real.sessions.listForOperator(operatorId)).resolves.toEqual([late]);
  } finally {
    await ctx.close();
  }
});
