import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { createMemoryIdentityStores } from '../../../src/modules/identity/stores/memoryStores.js';
import { createFakeClock } from '../../support/clock.js';
import { describeIdentityStoreContract } from '../../support/identityStoreContract.js';

describeIdentityStoreContract('memory', async () => ({ stores: createMemoryIdentityStores(createFakeClock()) }));

test('memory sessions and families expire on the clock, superseded hashes with them', async () => {
  const clock = createFakeClock();
  const stores = createMemoryIdentityStores(clock);
  const operatorId = randomUUID();
  const familyId = randomUUID();
  const sessionId = randomUUID();
  await stores.sessions.create({ sessionId, operatorId, familyId, createdAt: clock.now(), userAgent: '', ip: '' }, 60);
  await stores.refresh.create({ familyId, sessionId, operatorId, tokenVersion: 1, currentHash: 'h0' }, 60);
  await stores.refresh.rotate(familyId, 'h0', 'h1');
  clock.advance(59_999);
  await expect(stores.sessions.get(sessionId)).resolves.not.toBeNull();
  await expect(stores.refresh.rotate(familyId, 'h0', 'h2')).resolves.toBe('reused');
  clock.advance(1);
  await expect(stores.sessions.get(sessionId)).resolves.toBeNull();
  await expect(stores.sessions.listForOperator(operatorId)).resolves.toEqual([]);
  await expect(stores.refresh.get(familyId)).resolves.toBeNull();
  await expect(stores.refresh.rotate(familyId, 'h0', 'h2')).resolves.toBe('missing');
});
