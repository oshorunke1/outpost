import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { EmailTakenError } from '../../src/modules/identity/repos/operatorRepo.js';
import type { OperatorRepo } from '../../src/modules/identity/repos/operatorRepo.js';

// One set of behaviours, run against the in-memory fake (unit) and MySQL (integration),
// so the fake can never quietly drift from the real thing.
export function describeOperatorRepoContract(
  label: string,
  setup: () => Promise<{ repo: OperatorRepo; teardown?: () => Promise<void> }>,
): void {
  describe(`OperatorRepo contract (${label})`, () => {
    let repo: OperatorRepo;
    let teardown: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      ({ repo, teardown } = await setup());
    });
    afterAll(async () => {
      await teardown?.();
    });

    const email = () => `op-${randomUUID()}@Outpost.Local`;
    const input = (address: string) => ({ email: address, passwordHash: 'hash-1', scopes: ['admin:read'] });

    test('create normalizes the email and starts at token version 1', async () => {
      const address = email();
      const created = await repo.create(input(`  ${address} `));
      expect(created).toMatchObject({ email: address.toLowerCase(), tokenVersion: 1, scopes: ['admin:read'] });
      await expect(repo.findById(created.id)).resolves.toEqual(created);
    });

    test('case and whitespace variants all find the same operator', async () => {
      const address = email();
      const created = await repo.create(input(address));
      for (const variant of [address.toUpperCase(), ` ${address} `, `\t${address.toLowerCase()}\n`, ` ${address.toUpperCase()}`]) {
        await expect(repo.findByEmail(variant)).resolves.toEqual(created);
      }
    });

    test('NFC and NFD spellings of the same accented address are the same operator', async () => {
      const id = randomUUID();
      const nfc = `josé-${id}@outpost.local`;
      const nfd = `josé-${id}@outpost.local`;
      expect(nfc).not.toBe(nfd);
      const created = await repo.create(input(nfc));
      await expect(repo.findByEmail(nfd)).resolves.toEqual(created);
      await expect(repo.create(input(nfd))).rejects.toBeInstanceOf(EmailTakenError);
    });

    test('addresses that differ only by an accent are different operators', async () => {
      const id = randomUUID();
      const plain = await repo.create(input(`jose-${id}@outpost.local`));
      const accented = await repo.create(input(`josé-${id}@outpost.local`));
      expect(accented.id).not.toBe(plain.id);
      await expect(repo.findByEmail(`jose-${id}@outpost.local`)).resolves.toEqual(plain);
      await expect(repo.findByEmail(`josé-${id}@outpost.local`)).resolves.toEqual(accented);
    });

    test('a case variant of an existing email is refused as EmailTakenError', async () => {
      const address = email();
      await repo.create(input(address));
      const error: unknown = await repo.create(input(` ${address.toUpperCase()} `)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EmailTakenError);
      expect((error as Error).message).toBe('an operator with this email already exists');
    });

    test('a duplicate email is refused, even when two creates race', async () => {
      const address = email();
      const results = await Promise.allSettled([repo.create(input(address)), repo.create(input(address.toUpperCase()))]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(rejected?.reason).toBeInstanceOf(EmailTakenError);
    });

    test('bumpTokenVersion counts up and setPasswordHash replaces the hash', async () => {
      const created = await repo.create(input(email()));
      await expect(repo.bumpTokenVersion(created.id)).resolves.toBe(2);
      await expect(repo.bumpTokenVersion(created.id)).resolves.toBe(3);
      await repo.setPasswordHash(created.id, 'hash-2');
      await expect(repo.findById(created.id)).resolves.toMatchObject({ tokenVersion: 3, passwordHash: 'hash-2' });
    });

    test('bumpTokenVersion on an unknown id fails with a clear error', async () => {
      const missing = randomUUID();
      await expect(repo.bumpTokenVersion(missing)).rejects.toThrow(`no operator ${missing}`);
    });

    test('unknown ids and emails are null', async () => {
      await expect(repo.findById(randomUUID())).resolves.toBeNull();
      await expect(repo.findByEmail(email())).resolves.toBeNull();
    });
  });
}
