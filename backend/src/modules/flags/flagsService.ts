import type { Clock } from '../../platform/clock.js';
import type { Db, RowDataPacket } from '../../platform/db.js';
import { AppError, summarizeCause } from '../../platform/errors.js';

export type FlagValue = boolean | number | string;

// Must match the seed rows in migrations/005_flags.sql (an integration test checks) and
// game/src/ReplicatedStorage/Shared/Configs/Flags.luau, the game's fallback values.
export const FLAG_DEFAULTS: Readonly<Record<string, FlagValue>> = Object.freeze({
  ShopEnabled: true,
  OrbSpawnMultiplier: 1,
  TelemetryEnabled: true,
});

export interface FlagsService {
  // Rejects with a 503 flags_unavailable AppError only when there is nothing good to serve.
  list(): Promise<Record<string, FlagValue>>;
}

// The smallest logger the flags service needs. A pino logger fits it as is.
export interface FlagsLogger {
  warn(details: object, message: string): void;
}

export interface MysqlFlagsOptions {
  logger: FlagsLogger;
  cacheMs?: number; // how long a read is reused, and how long a failed reload waits (default 5000)
}

export const FLAG_CACHE_MS = 5_000;
// After a failed load with nothing cached, callers get the 503 straight away for this long, which
// matches its Retry-After of 1.
export const FLAGS_COLD_RETRY_MS = 1_000;

export function createMemoryFlagsService(values: Record<string, FlagValue> = { ...FLAG_DEFAULTS }): FlagsService {
  return { list: async () => ({ ...values }) };
}

function isFlagValue(value: unknown): value is FlagValue {
  return typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

const unavailable = (cause: unknown) =>
  new AppError(503, 'flags_unavailable', 'Flags are temporarily unavailable', { cause, headers: { 'retry-after': '1' } });

// A short cache: every game server polls each minute, and flags change rarely. A row overrides its
// default, so a deleted row falls back to the default. If a reload fails the last good values are
// served stale (logged) and the next try waits a full cache period, so an outage is not hammered.
// Only one load runs at a time and everyone waiting shares it, so a burst of callers on an expired
// cache makes one query (and an older load can never overwrite a newer one).
export function createMysqlFlagsService(db: Db, clock: Clock, options: MysqlFlagsOptions): FlagsService {
  const cacheMs = options.cacheMs ?? FLAG_CACHE_MS;
  let cached: Record<string, FlagValue> | null = null;
  let freshUntil = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<Record<string, FlagValue>> | null = null;
  let coldError: unknown = null;
  let coldRetryAt = Number.NEGATIVE_INFINITY;

  async function load(): Promise<Record<string, FlagValue>> {
    const [rows] = await db.query<RowDataPacket[]>('SELECT flag_key, flag_value FROM flags ORDER BY flag_key');
    const values: Record<string, FlagValue> = { ...FLAG_DEFAULTS };
    for (const row of rows) {
      const flagKey = String(row.flag_key);
      const value: unknown = row.flag_value;
      if (isFlagValue(value)) values[flagKey] = value;
      else options.logger.warn({ flagKey, valueType: jsonType(value) }, 'flag value is not a boolean, number or string; using the default');
    }
    return values;
  }

  async function reload(): Promise<Record<string, FlagValue>> {
    try {
      cached = await load();
    } catch (error) {
      if (!cached) {
        coldError = error;
        coldRetryAt = clock.now() + FLAGS_COLD_RETRY_MS;
        throw unavailable(error);
      }
      options.logger.warn({ cause: summarizeCause(error) }, 'flag reload failed; serving the last good values');
    }
    freshUntil = clock.now() + cacheMs;
    return cached;
  }

  return {
    async list() {
      if (cached && clock.now() < freshUntil) return { ...cached };
      if (!cached && clock.now() < coldRetryAt) throw unavailable(coldError);
      inFlight ??= reload().finally(() => {
        inFlight = null;
      });
      return { ...(await inFlight) };
    },
  };
}
