--!strict
-- SaveGate decides how far a save is upgraded when it loads, and which economy that player gets.
-- Ledger is a server that talks to the backend ledger. Every save is upgraded, and Coins live in the ledger.
-- Legacy is a server that does not talk to the ledger yet, with a version 1 save. The save stays on
-- version 1 and the old DataStore Coins work exactly as they did in M1.
-- Paused is a server that does not talk to the ledger, with a save that already moved to it. A save
-- never goes back to version 1, because that would bring back Coins the ledger now holds. That
-- player's Coins wait in the ledger until they join a server that talks to it.
-- Nothing here touches game. The migrations and the Migrator's Run are passed in.

export type Economy = "Ledger" | "Legacy" | "Paused"
export type Outcome = {
	Ok: boolean,
	Data: { [string]: any }?,
	Error: string?,
	FromVersion: number,
	ToVersion: number,
}
type Migration = (Data: { [string]: any }) -> ()
type Run = (Data: { [string]: any }, MigrationList: { Migration }) -> Outcome

local SaveGate = {}

-- The first save version without Coins in it. Migrations[LedgerVersion - 1] is the move to the ledger.
SaveGate.LedgerVersion = 2

function SaveGate.Prepare(
	Data: { [string]: any },
	MigrationList: { Migration },
	Run: Run,
	Live: boolean
): (Outcome, Economy)
	if Live then
		return Run(Data, MigrationList), "Ledger"
	end
	local Version = Data.SchemaVersion
	if type(Version) == "number" and Version >= SaveGate.LedgerVersion then
		return Run(Data, MigrationList), "Paused"
	end
	-- Only the upgrades from before the ledger, so an old save stops at version 1.
	local Before = table.move(MigrationList, 1, SaveGate.LedgerVersion - 2, 1, {})
	return Run(Data, Before), "Legacy"
end

-- A server without the ledger opens its store with the version 1 template, so Reconcile puts a
-- Coins field on a ledger save. This takes it off again, so a ledger save never holds Coins.
function SaveGate.Tidy(Data: { [string]: any })
	local Version = Data.SchemaVersion
	if type(Version) == "number" and Version >= SaveGate.LedgerVersion then
		Data.Coins = nil
	end
end

-- The template a server opens its store with. A brand new player on a server without the ledger
-- gets the version 1 save with Coins, the same as M1.
function SaveGate.DefaultsFor<T>(Live: boolean, Templates: { Defaults: T, LegacyDefaults: T }): T
	return if Live then Templates.Defaults else Templates.LegacyDefaults
end

return SaveGate
