--!strict
local Harness = require("@Tests/Harness")
local Migrations = require("@Logic/Data/Migrations")
local Migrator = require("@Logic/Data/Migrator")
local SaveGate = require("@Logic/Data/SaveGate")
local Template = require("@Logic/Data/Template")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

local function OldSave(): { [string]: any }
	return { SchemaVersion = 1, Coins = 40, OwnedItems = { RedHat = true }, Stats = { OrbsCollected = 8 } }
end

local function NewSave(): { [string]: any }
	return { SchemaVersion = 2, LegacyCoins = 40, OwnedItems = { RedHat = true }, Stats = { OrbsCollected = 8 } }
end

Describe("SaveGate", function()
	It("the ledger version is the template version, the first save without Coins", function()
		Expect(SaveGate.LedgerVersion).ToBe(Template.SchemaVersion)
		Expect(SaveGate.LedgerVersion).ToBe(Template.LegacyVersion + 1)
	end)

	It("a live server moves an old save to the ledger", function()
		local Outcome, Economy = SaveGate.Prepare(OldSave(), Migrations, Migrator.Run, true)
		Expect(Economy).ToBe("Ledger")
		Expect(Outcome.Ok).ToBe(true)
		Expect(Outcome.Data).ToEqual(NewSave())
	end)

	It("a live server keeps a save already on the ledger as it is", function()
		local Outcome, Economy = SaveGate.Prepare(NewSave(), Migrations, Migrator.Run, true)
		Expect(Economy).ToBe("Ledger")
		Expect(Outcome.Data).ToEqual(NewSave())
	end)

	It("a server without the ledger leaves an old save on version 1 with its Coins", function()
		local Outcome, Economy = SaveGate.Prepare(OldSave(), Migrations, Migrator.Run, false)
		Expect(Economy).ToBe("Legacy")
		Expect(Outcome.Ok).ToBe(true)
		Expect(Outcome.Data).ToEqual(OldSave())
		Expect(Outcome.ToVersion).ToBe(1)
	end)

	It("a server without the ledger never takes a ledger save back to version 1, it pauses its economy", function()
		local Outcome, Economy = SaveGate.Prepare(NewSave(), Migrations, Migrator.Run, false)
		Expect(Economy).ToBe("Paused")
		Expect(Outcome.Ok).ToBe(true)
		Expect(Outcome.Data).ToEqual(NewSave())
		Expect((Outcome.Data :: any).Coins).ToBeNil()
	end)

	It("a save from a newer version than this server knows is still refused", function()
		for _, Live in { true, false } do
			local Outcome = SaveGate.Prepare({ SchemaVersion = 9 }, Migrations, Migrator.Run, Live)
			Expect(Outcome.Ok).ToBe(false)
		end
	end)

	It("Tidy drops a Coins field that Reconcile put on a ledger save, and leaves an old save alone", function()
		local Ledger = NewSave()
		Ledger.Coins = 0
		SaveGate.Tidy(Ledger)
		Expect(Ledger).ToEqual(NewSave())
		local Old = OldSave()
		SaveGate.Tidy(Old)
		Expect(Old).ToEqual(OldSave())
	end)

	It("the store template follows the gate, so a new player on a server without the ledger gets Coins", function()
		Expect(SaveGate.DefaultsFor(true, Template)).ToBe(Template.Defaults)
		Expect(SaveGate.DefaultsFor(false, Template)).ToBe(Template.LegacyDefaults)
	end)
end)

return nil
