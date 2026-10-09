import { z } from 'zod';
import { ITEM_IDS } from '../economy/catalog.js';
import { userIdBody } from '../players/params.js';

// Every name, dimension key and dimension value comes from a fixed list, so rollup cardinality stays
// bounded and no free text a player typed ever reaches the stream (ADR 0009). The value lists match
// the names the game uses, and an unknown value is a 400 for the whole batch.
export const EVENT_NAMES = ['player_join', 'player_leave', 'orb_collected', 'earn_flush', 'purchase_result', 'breaker_state', 'netguard_drop'] as const;
export const DIMENSION_KEYS = ['outcome', 'itemId', 'state', 'packet', 'reason'] as const;

// ShopService's Shop.Result outcomes: Pricing.Outcome plus Unavailable when the save failed.
export const PURCHASE_OUTCOMES = ['Granted', 'AlreadyOwned', 'TooPoor', 'UnknownItem', 'Unavailable'] as const;
// The game's CircuitBreaker.State (plan Task 26).
export const BREAKER_STATES = ['Closed', 'Open', 'HalfOpen'] as const;
// Every packet in game/src/ReplicatedStorage/Shared/Net/Packets.luau. A drop of a name that is not a
// real packet is reported as Unknown, because that name came from a client and is free text.
export const PACKET_NAMES = ['Orb.Collect', 'Profile.RequestSnapshot', 'Profile.Snapshot', 'Shop.Buy', 'Shop.Result', 'Unknown'] as const;
// PacketGate.Reason without Ok, since only refused packets are dropped.
export const DROP_REASONS = ['UnknownPacket', 'WrongDirection', 'NoHandler', 'TooManyArguments', 'Throttled', 'BadPayload'] as const;

export const MAX_EVENTS_PER_BATCH = 500;
export const MAX_FUTURE_SKEW_MS = 5 * 60_000;
export const MAX_EVENT_AGE_MS = 24 * 60 * 60_000;

const dimensionsSchema = z
  .object({
    outcome: z.enum(PURCHASE_OUTCOMES).optional(),
    itemId: z.enum(ITEM_IDS).optional(),
    state: z.enum(BREAKER_STATES).optional(),
    packet: z.enum(PACKET_NAMES).optional(),
    reason: z.enum(DROP_REASONS).optional(),
  } satisfies Record<(typeof DIMENSION_KEYS)[number], z.ZodType>)
  .strict();

export const telemetryEventSchema = z
  .object({
    name: z.enum(EVENT_NAMES),
    ts: z.number().int().positive(), // epoch milliseconds, from the game server's clock
    userId: userIdBody.optional(),
    value: z.number().min(-1e9).max(1e9).optional(),
    dims: dimensionsSchema.optional(),
  })
  .strict();

export const telemetryBatchSchema = z.object({ events: z.array(telemetryEventSchema).min(1).max(MAX_EVENTS_PER_BATCH) }).strict();

export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;

// The game server's clock decides which rollup bucket an event lands in, so events too far in the
// future or too old are dropped (and counted) instead of landing in the wrong bucket.
export function splitByClock(events: readonly TelemetryEvent[], now: number): { kept: TelemetryEvent[]; dropped: number } {
  const kept = events.filter((event) => event.ts <= now + MAX_FUTURE_SKEW_MS && event.ts >= now - MAX_EVENT_AGE_MS);
  return { kept, dropped: events.length - kept.length };
}
