--!strict
-- The starting save for a brand new player. ProfileService copies Defaults for new players,
-- and Reconcile fills in any field an older save is missing.
-- When you rename, move or retype a field, bump SchemaVersion and add a matching migration in Migrations.
-- Coins are not here. From M2 on they live in the backend ledger, see EconomyService.
-- A server that does not talk to the ledger yet keeps playing the old version 1 save, Coins and all,
-- so LegacyFresh is that save. SaveGate picks which one a server uses.

export type ProfileData = {
	SchemaVersion: number,
	-- Only a version 1 save has this, on a server that does not talk to the ledger yet.
	Coins: number?,
	-- The Coins a version 1 save had when it moved to the ledger. They are credited to the ledger once.
	LegacyCoins: number?,
	-- True once LegacyCoins are in the ledger, so they are never credited twice.
	LegacyCredited: boolean?,
	OwnedItems: { [string]: boolean },
	Stats: { OrbsCollected: number },
}

local Template = {}

Template.SchemaVersion = 2
Template.LegacyVersion = 1

function Template.Fresh(): ProfileData
	return {
		SchemaVersion = Template.SchemaVersion,
		OwnedItems = {},
		Stats = { OrbsCollected = 0 },
	}
end

function Template.LegacyFresh(): ProfileData
	return {
		SchemaVersion = Template.LegacyVersion,
		Coins = 0,
		OwnedItems = {},
		Stats = { OrbsCollected = 0 },
	}
end

Template.Defaults = Template.Fresh()
Template.LegacyDefaults = Template.LegacyFresh()

return Template
