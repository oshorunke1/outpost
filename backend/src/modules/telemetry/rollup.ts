import { canonicalJson, sha256Hex } from '../../platform/canonicalJson.js';
import type { TelemetryEvent } from './schema.js';

export interface RollupRow {
  metric: string;
  bucketStart: number; // epoch milliseconds, floored to the minute
  dims: Record<string, string>;
  dimsHash: string; // sha256 of the canonical dims JSON, part of the rollup table's key
  count: number;
  sum: number;
}

export function minuteBucket(ts: number): number {
  return Math.floor(ts / 60_000) * 60_000;
}

// Pure aggregation: one row per metric, minute and set of dimensions. The dims were already
// checked against the per-key allow lists in the schema, so they are used exactly as they are, and
// dimension order never matters. Rows come back in one fixed order, so every worker writes rollup
// rows in the same order and two workers never wait on each other's rows in a cycle.
export function rollUp(events: readonly TelemetryEvent[]): RollupRow[] {
  const rows = new Map<string, RollupRow>();
  for (const event of events) {
    const dimsText = canonicalJson(event.dims ?? {});
    const dimsHash = sha256Hex(dimsText);
    const bucketStart = minuteBucket(event.ts);
    const key = `${event.name}|${bucketStart}|${dimsHash}`;
    let row = rows.get(key);
    if (!row) {
      row = { metric: event.name, bucketStart, dims: JSON.parse(dimsText) as Record<string, string>, dimsHash, count: 0, sum: 0 };
      rows.set(key, row);
    }
    row.count += 1;
    row.sum += event.value ?? 0;
  }
  return [...rows.values()].sort((a, b) => compareText(a.metric, b.metric) || a.bucketStart - b.bucketStart || compareText(a.dimsHash, b.dimsHash));
}

// Plain code unit order, the same on every machine (localeCompare can differ by locale).
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
