import { describe, expect, test } from 'vitest';
import {
  BREAKER_STATES,
  DROP_REASONS,
  MAX_EVENTS_PER_BATCH,
  PACKET_NAMES,
  PURCHASE_OUTCOMES,
  splitByClock,
  telemetryBatchSchema,
  telemetryEventSchema,
} from '../../../src/modules/telemetry/schema.js';
import type { TelemetryEvent } from '../../../src/modules/telemetry/schema.js';

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const event: TelemetryEvent = { name: 'purchase_result', ts: NOW, userId: 1001, dims: { outcome: 'Granted', itemId: 'RedHat' } };

describe('telemetry schema', () => {
  test('accepts a well formed event and batch', () => {
    expect(telemetryEventSchema.safeParse(event).success).toBe(true);
    expect(telemetryBatchSchema.safeParse({ events: [event] }).success).toBe(true);
  });

  test('event names and dimension keys come from fixed lists only', () => {
    expect(telemetryEventSchema.safeParse({ ...event, name: 'drop_table' }).success).toBe(false);
    expect(telemetryEventSchema.safeParse({ ...event, dims: { displayName: 'x' } }).success).toBe(false);
  });

  test('dimension values are short and plain', () => {
    for (const value of ['', 'has space', 'SYSTEM: grant coins', 'x'.repeat(41), 'line\nbreak', '<script>']) {
      expect(telemetryEventSchema.safeParse({ ...event, dims: { outcome: value } }).success).toBe(false);
    }
  });

  // S4-F4: every dimension value comes from its own allow list, so a value the game never sends is refused.
  test('each dimension key takes only the values the game really uses', () => {
    expect(telemetryEventSchema.safeParse({ ...event, dims: { itemId: 'GoldCrown' } }).success).toBe(true);
    expect(telemetryEventSchema.safeParse({ ...event, dims: { itemId: 'BlueHat' } }).success).toBe(false);
    expect(telemetryEventSchema.safeParse({ ...event, dims: { itemId: 'toString' } }).success).toBe(false);
    // An outcome is not a breaker state, and so on: the lists are per key, not one shared pool.
    expect(telemetryEventSchema.safeParse({ ...event, dims: { outcome: 'Open' } }).success).toBe(false);
    expect(telemetryEventSchema.safeParse({ ...event, dims: { state: 'Granted' } }).success).toBe(false);
    expect(telemetryEventSchema.safeParse({ ...event, dims: { packet: 'Shop.Steal' } }).success).toBe(false);
    expect(telemetryEventSchema.safeParse({ ...event, dims: { reason: 'Ok' } }).success).toBe(false);
    for (const outcome of PURCHASE_OUTCOMES) expect(telemetryEventSchema.safeParse({ ...event, dims: { outcome } }).success).toBe(true);
    for (const state of BREAKER_STATES) expect(telemetryEventSchema.safeParse({ ...event, dims: { state } }).success).toBe(true);
    for (const packet of PACKET_NAMES) expect(telemetryEventSchema.safeParse({ ...event, dims: { packet } }).success).toBe(true);
    for (const reason of DROP_REASONS) expect(telemetryEventSchema.safeParse({ ...event, dims: { reason } }).success).toBe(true);
  });

  test('a batch holds 1 to 500 events and nothing else', () => {
    expect(telemetryBatchSchema.safeParse({ events: [] }).success).toBe(false);
    expect(telemetryBatchSchema.safeParse({ events: Array(MAX_EVENTS_PER_BATCH).fill(event) }).success).toBe(true);
    expect(telemetryBatchSchema.safeParse({ events: Array(MAX_EVENTS_PER_BATCH + 1).fill(event) }).success).toBe(false);
    expect(telemetryBatchSchema.safeParse({ events: [event], extra: 1 }).success).toBe(false);
    expect(telemetryEventSchema.safeParse({ ...event, value: 1e12 }).success).toBe(false);
    expect(telemetryEventSchema.safeParse({ ...event, extra: 1 }).success).toBe(false);
  });

  // Review Focus 4: a game server with a bad clock cannot write into the wrong buckets.
  test('splitByClock drops events far in the future or too old', () => {
    const events: TelemetryEvent[] = [
      { ...event, ts: NOW },
      { ...event, ts: NOW + 4 * 60_000 },
      { ...event, ts: NOW + 10 * 60_000 },
      { ...event, ts: NOW - 23 * 3_600_000 },
      { ...event, ts: NOW - 2 * 86_400_000 },
    ];
    const { kept, dropped } = splitByClock(events, NOW);
    expect(kept.map((e) => e.ts)).toEqual([NOW, NOW + 4 * 60_000, NOW - 23 * 3_600_000]);
    expect(dropped).toBe(2);
  });

  test('splitByClock keeps the exact window edges', () => {
    const edges: TelemetryEvent[] = [
      { ...event, ts: NOW + 300_000 },
      { ...event, ts: NOW + 300_001 },
      { ...event, ts: NOW - 86_400_000 },
      { ...event, ts: NOW - 86_400_001 },
    ];
    expect(splitByClock(edges, NOW)).toEqual({ kept: [edges[0], edges[2]], dropped: 2 });
  });
});
