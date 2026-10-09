import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { IdentityStores, RefreshFamily, SessionRecord } from '../../src/modules/identity/stores/types.js';

export function describeIdentityStoreContract(
  label: string,
  setup: () => Promise<{ stores: IdentityStores; teardown?: () => Promise<void> }>,
): void {
  describe(`identity stores contract (${label})`, () => {
    let stores: IdentityStores;
    let teardown: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      ({ stores, teardown } = await setup());
    });
    afterAll(async () => {
      await teardown?.();
    });

    const session = (operatorId: string, createdAt: number): SessionRecord => ({
      sessionId: randomUUID(),
      operatorId,
      familyId: randomUUID(),
      createdAt,
      userAgent: 'outpost-cli/0.1',
      ip: '127.0.0.1',
    });

    const family = (currentHash = 'h0'): RefreshFamily => ({
      familyId: randomUUID(),
      sessionId: randomUUID(),
      operatorId: randomUUID(),
      tokenVersion: 3,
      currentHash,
    });

    test('sessions are created, listed in age order and deleted', async () => {
      const operatorId = randomUUID();
      const first = session(operatorId, 1000);
      const second = session(operatorId, 2000);
      await stores.sessions.create(second, 3600);
      await stores.sessions.create(first, 3600);
      await expect(stores.sessions.get(first.sessionId)).resolves.toEqual(first);
      await expect(stores.sessions.listForOperator(operatorId)).resolves.toEqual([first, second]);
      await expect(stores.sessions.delete(first.sessionId)).resolves.toEqual(first);
      await expect(stores.sessions.listForOperator(operatorId)).resolves.toEqual([second]);
      await expect(stores.sessions.delete(first.sessionId)).resolves.toBeNull();
      await expect(stores.sessions.get(first.sessionId)).resolves.toBeNull();
    });

    test('deleteAllForOperator removes every session of that operator only', async () => {
      const mine = randomUUID();
      const theirs = randomUUID();
      await stores.sessions.create(session(mine, 1), 3600);
      await stores.sessions.create(session(mine, 2), 3600);
      const other = session(theirs, 3);
      await stores.sessions.create(other, 3600);
      await expect(stores.sessions.deleteAllForOperator(mine)).resolves.toHaveLength(2);
      await expect(stores.sessions.listForOperator(mine)).resolves.toEqual([]);
      await expect(stores.sessions.listForOperator(theirs)).resolves.toEqual([other]);
    });

    test('a family round-trips with its token version', async () => {
      const created = family();
      await stores.refresh.create(created, 3600);
      await expect(stores.refresh.get(created.familyId)).resolves.toEqual(created);
      await expect(stores.refresh.get(randomUUID())).resolves.toBeNull();
    });

    test('rotate moves the family forward and calls the old hash a reuse', async () => {
      const created = family('h0');
      await stores.refresh.create(created, 3600);
      await expect(stores.refresh.rotate(created.familyId, 'h0', 'h1')).resolves.toBe('rotated');
      await expect(stores.refresh.rotate(created.familyId, 'h0', 'h2')).resolves.toBe('reused');
      // A reuse report changes nothing by itself. Revoking is the service's call.
      await expect(stores.refresh.get(created.familyId)).resolves.toMatchObject({ currentHash: 'h1' });
    });

    test('a hash the family never issued is unknown, not a reuse, and changes nothing', async () => {
      const created = family('h0');
      await stores.refresh.create(created, 3600);
      await expect(stores.refresh.rotate(created.familyId, 'forged', 'h1')).resolves.toBe('unknown');
      await expect(stores.refresh.get(created.familyId)).resolves.toMatchObject({ currentHash: 'h0' });
      await expect(stores.refresh.rotate(created.familyId, 'h0', 'h1')).resolves.toBe('rotated');
    });

    test('only the last 10 superseded hashes are remembered', async () => {
      const created = family('h0');
      await stores.refresh.create(created, 3600);
      for (let i = 0; i < 11; i += 1) {
        await expect(stores.refresh.rotate(created.familyId, `h${i}`, `h${i + 1}`)).resolves.toBe('rotated');
      }
      // h0 was pushed out by h1..h10, so it is just an unknown hash now.
      await expect(stores.refresh.rotate(created.familyId, 'h0', 'x')).resolves.toBe('unknown');
      await expect(stores.refresh.rotate(created.familyId, 'h1', 'x')).resolves.toBe('reused');
      await expect(stores.refresh.rotate(created.familyId, 'h10', 'x')).resolves.toBe('reused');
      await expect(stores.refresh.get(created.familyId)).resolves.toMatchObject({ currentHash: 'h11' });
    });

    test('a deleted family is missing, and so are its superseded hashes', async () => {
      const created = family('h0');
      await stores.refresh.create(created, 3600);
      await stores.refresh.rotate(created.familyId, 'h0', 'h1');
      await stores.refresh.delete(created.familyId);
      await expect(stores.refresh.get(created.familyId)).resolves.toBeNull();
      await expect(stores.refresh.rotate(created.familyId, 'h1', 'h2')).resolves.toBe('missing');
      await expect(stores.refresh.rotate(created.familyId, 'h0', 'h2')).resolves.toBe('missing');
    });

    test('two refreshes racing with the same token: one rotates, the other is a reuse', async () => {
      const created = family('h0');
      await stores.refresh.create(created, 3600);
      const outcomes = await Promise.all([
        stores.refresh.rotate(created.familyId, 'h0', 'a'),
        stores.refresh.rotate(created.familyId, 'h0', 'b'),
      ]);
      expect([...outcomes].sort()).toEqual(['reused', 'rotated']);
      const after = await stores.refresh.get(created.familyId);
      expect(['a', 'b']).toContain(after?.currentHash);
    });
  });
}
