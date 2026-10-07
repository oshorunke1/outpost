--!strict
-- The starting save for a brand new player. ProfileService copies Defaults for new players,
-- and Reconcile fills in any field an older save is missing.
-- When you rename, move or retype a field, bump SchemaVersion and add a matching migration in Migrations.

export type ProfileData = {
	SchemaVersion: number,
	Coins: number,
	OwnedItems: { [string]: boolean },
	Stats: { OrbsCollected: number },
}

local Template = {}

Template.SchemaVersion = 1

function Template.Fresh(): ProfileData
	return {
		SchemaVersion = Template.SchemaVersion,
		Coins = 0,
		OwnedItems = {},
		Stats = { OrbsCollected = 0 },
	}
end

Template.Defaults = Template.Fresh()

return Template
