import { describe, expect, test } from 'vitest';
import { createMemoryOperatorRepo, normalizeEmail } from '../../../src/modules/identity/repos/operatorRepo.js';
import { describeOperatorRepoContract } from '../../support/operatorRepoContract.js';

describeOperatorRepoContract('memory', async () => ({ repo: createMemoryOperatorRepo() }));

describe('normalizeEmail', () => {
  test('trims and lowercases', () => {
    expect(normalizeEmail('  Joel@Outpost.LOCAL\t')).toBe('joel@outpost.local');
  });

  test('NFC and NFD forms of the same accented address normalize to the same string', () => {
    const nfc = 'josé@outpost.local';
    const nfd = 'josé@outpost.local';
    expect(nfc).not.toBe(nfd);
    expect(normalizeEmail(nfd)).toBe(normalizeEmail(nfc));
    expect(normalizeEmail(nfd)).toBe(nfc);
  });

  test('an accent still makes a different address', () => {
    expect(normalizeEmail('josé@x.io')).not.toBe(normalizeEmail('jose@x.io'));
  });
});
