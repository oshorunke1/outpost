--!strict
local Harness = require("@Tests/Harness")
local Migrator = require("@Logic/Data/Migrator")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

local function AddGems(Data: { [string]: any })
	Data.Gems = 0
end

local function RenameGemsToCrystals(Data: { [string]: any })
	Data.Crystals = Data.Gems
	Data.Gems = nil
end

Describe("Migrator.Run", function()
	It("does nothing to a save that is already current", function()
		local Outcome = Migrator.Run({ SchemaVersion = 1, Coins = 4 }, {})
		Expect(Outcome.Ok).ToBe(true)
		Expect(Outcome.Data).ToEqual({ SchemaVersion = 1, Coins = 4 })
		Expect(Outcome.FromVersion).ToBe(1)
		Expect(Outcome.ToVersion).ToBe(1)
	end)

	It("runs every migration in order from the save's own version", function()
		local Outcome = Migrator.Run({ SchemaVersion = 1 }, { AddGems, RenameGemsToCrystals })
		Expect(Outcome.Ok).ToBe(true)
		Expect(Outcome.Data).ToEqual({ SchemaVersion = 3, Crystals = 0 })
		local Later = Migrator.Run({ SchemaVersion = 2, Gems = 5 }, { AddGems, RenameGemsToCrystals })
		Expect(Later.Data).ToEqual({ SchemaVersion = 3, Crystals = 5 })
		Expect(Later.FromVersion).ToBe(2)
	end)

	It("treats a save with no SchemaVersion as version 1", function()
		local Outcome = Migrator.Run({ Coins = 1 }, { AddGems })
		Expect(Outcome.Ok).ToBe(true)
		Expect(Outcome.Data).ToEqual({ SchemaVersion = 2, Coins = 1, Gems = 0 })
	end)

	It("refuses a save from a newer version and leaves it alone", function()
		local Original = { SchemaVersion = 5, Coins = 9 }
		local Outcome = Migrator.Run(Original, { AddGems })
		Expect(Outcome.Ok).ToBe(false)
		Expect(string.find(Outcome.Error or "", "newer", 1, true) ~= nil).ToBe(true)
		Expect(Original).ToEqual({ SchemaVersion = 5, Coins = 9 })
	end)

	It("refuses a SchemaVersion that is not a whole number of at least 1", function()
		Expect(Migrator.Run({ SchemaVersion = "2" }, {}).Ok).ToBe(false)
		Expect(Migrator.Run({ SchemaVersion = 1.5 }, { AddGems }).Ok).ToBe(false)
		Expect(Migrator.Run({ SchemaVersion = 0 }, {}).Ok).ToBe(false)
	end)

	It("leaves the original untouched when a migration throws", function()
		local Original = { SchemaVersion = 1, Coins = 10, Stats = { Wins = 2 } }
		local function Broken(Data: { [string]: any })
			Data.Coins = 999
			Data.Stats.Wins = 999
			error("boom")
		end
		local Outcome = Migrator.Run(Original, { Broken })
		Expect(Outcome.Ok).ToBe(false)
		Expect(string.find(Outcome.Error or "", "migration 1 to 2 failed", 1, true) ~= nil).ToBe(true)
		Expect(Original).ToEqual({ SchemaVersion = 1, Coins = 10, Stats = { Wins = 2 } })
	end)

	It("hands back a copy, so changing the result never changes the input", function()
		local Original = { SchemaVersion = 1, Stats = { Wins = 1 } }
		local Outcome = Migrator.Run(Original, {})
		local Data = Outcome.Data :: { [string]: any }
		Data.Stats.Wins = 50
		Expect(Original.Stats.Wins).ToBe(1)
	end)
end)

return nil
