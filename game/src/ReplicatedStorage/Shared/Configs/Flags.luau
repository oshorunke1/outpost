--!strict
-- The game's fallback flag values, used until the first good poll and whenever the backend can't
-- be reached. They must match FLAG_DEFAULTS in backend/src/modules/flags/flagsService.ts and the
-- seed rows in backend/migrations/005_flags.sql. The FlagValues spec reads both files and fails
-- when they drift, and the contract suite checks the live answer too.
export type Flags = { ShopEnabled: boolean, OrbSpawnMultiplier: number, TelemetryEnabled: boolean }

local Flags: Flags = {
	ShopEnabled = true,
	OrbSpawnMultiplier = 1,
	TelemetryEnabled = true,
}

return table.freeze(Flags)
