import { describe, expect, test } from 'vitest';
import { sha256Hex } from '../../../src/platform/canonicalJson.js';
import { minuteBucket, rollUp } from '../../../src/modules/telemetry/rollup.js';

const T = Date.UTC(2026, 9, 8, 12, 0, 0);

describe('rollUp', () => {
  test('groups by metric, minute and dimensions, counting and summing', () => {
    const rows = rollUp([
      { name: 'purchase_result', ts: T + 1_000, dims: { outcome: 'Granted', itemId: 'RedHat' } },
      { name: 'purchase_result', ts: T + 59_000, dims: { itemId: 'RedHat', outcome: 'Granted' } },
      { name: 'purchase_result', ts: T + 61_000, dims: { outcome: 'Granted', itemId: 'RedHat' } },
      { name: 'earn_flush', ts: T, value: 200 },
      { name: 'earn_flush', ts: T, value: 35 },
    ]);
    expect(rows.map(({ metric, bucketStart, dims, count, sum }) => ({ metric, bucketStart, dims, count, sum }))).toEqual([
      { metric: 'earn_flush', bucketStart: T, dims: {}, count: 2, sum: 235 },
      { metric: 'purchase_result', bucketStart: T, dims: { itemId: 'RedHat', outcome: 'Granted' }, count: 2, sum: 0 },
      { metric: 'purchase_result', bucketStart: T + 60_000, dims: { itemId: 'RedHat', outcome: 'Granted' }, count: 1, sum: 0 },
    ]);
  });

  test('the dimensions hash is the sha256 of the canonical dimensions, so key order never splits a row', () => {
    const [a, b] = [
      rollUp([{ name: 'purchase_result', ts: T, dims: { outcome: 'TooPoor', itemId: 'RedHat' } }]),
      rollUp([{ name: 'purchase_result', ts: T, dims: { itemId: 'RedHat', outcome: 'TooPoor' } }]),
    ];
    expect(a[0]?.dimsHash).toBe(sha256Hex('{"itemId":"RedHat","outcome":"TooPoor"}'));
    expect(b[0]?.dimsHash).toBe(a[0]?.dimsHash);
    expect(rollUp([{ name: 'player_join', ts: T }])[0]?.dimsHash).toBe(sha256Hex('{}'));
  });

  test('an empty batch rolls up to nothing', () => {
    expect(rollUp([])).toEqual([]);
  });

  test('minuteBucket floors to the minute', () => {
    expect(minuteBucket(T + 59_999)).toBe(T);
    expect(minuteBucket(T + 60_000)).toBe(T + 60_000);
  });
});
