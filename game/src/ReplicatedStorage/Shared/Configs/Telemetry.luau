--!strict
-- The telemetry names and values the backend accepts, copied from its allow lists so the game can
-- clean an event before it is queued. The backend refuses the whole batch if one value is off.
-- These mirror backend/src/modules/telemetry/schema.ts and the CATALOG keys in
-- backend/src/modules/economy/catalog.ts. Change both sides together. The TelemetryBuffer spec
-- reads those files and fails when the two drift apart.

export type Telemetry = {
	EventNames: { string },
	DimValues: { [string]: { string } },
	DimFallbacks: { [string]: string },
	MaxEventsPerBatch: number,
	MaxBodyBytes: number,
}

local Telemetry: Telemetry = {
	EventNames = {
		"player_join",
		"player_leave",
		"orb_collected",
		"earn_flush",
		"purchase_result",
		"breaker_state",
		"netguard_drop",
	},
	-- Every dims key the backend knows, each with the only values it allows.
	DimValues = {
		outcome = { "Granted", "AlreadyOwned", "TooPoor", "UnknownItem", "Unavailable" },
		itemId = { "RedHat", "GoldCrown" },
		state = { "Closed", "Open", "HalfOpen" },
		packet = { "Orb.Collect", "Profile.RequestSnapshot", "Profile.Snapshot", "Shop.Buy", "Shop.Result", "Unknown" },
		reason = { "UnknownPacket", "WrongDirection", "NoHandler", "TooManyArguments", "Throttled", "BadPayload" },
	},
	-- A packet name came from a client, so a bad one is reported as Unknown instead of dropped.
	DimFallbacks = { packet = "Unknown" },
	-- MAX_EVENTS_PER_BATCH in schema.ts and TELEMETRY_BODY_LIMIT_BYTES in telemetry/routes.ts.
	MaxEventsPerBatch = 500,
	MaxBodyBytes = 512 * 1024,
}

return table.freeze(Telemetry)
