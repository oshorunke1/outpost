--!strict
local Harness = require("@Tests/Harness")
local Migrations = require("@Logic/Data/Migrations")
local Migrator = require("@Logic/Data/Migrator")
local Template = require("@Logic/Data/Template")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

-- selene: allow(divide_by_zero)
local NaN = 0 / 0

local function Upgrade(Data: { [string]: any }): { [string]: any }?
	local Outcome = Migrator.Run(Data, Migrations)
	Expect(Outcome.Ok).ToBe(true)
	return Outcome.Data
end

Describe("Migrations", function()
	It("version 1 to 2 keeps the old Coins as LegacyCoins, for the one time ledger credit", function()
		Expect(Upgrade({
			SchemaVersion = 1,
			Coins = 40,
			OwnedItems = { RedHat = true },
			Stats = { OrbsCollected = 8 },
		})).ToEqual({
			SchemaVersion = 2,
			LegacyCoins = 40,
			OwnedItems = { RedHat = true },
			Stats = { OrbsCollected = 8 },
		})
	end)

	It("a save with no SchemaVersion is version 1 and keeps its Coins the same way", function()
		Expect((Upgrade({ Coins = 7, OwnedItems = {}, Stats = { OrbsCollected = 0 } }) :: any).LegacyCoins).ToBe(7)
	end)

	It("a big balance is kept whole, never cut to the 1000 a single earn can carry", function()
		Expect((Upgrade({ Coins = 123456, OwnedItems = {}, Stats = { OrbsCollected = 0 } }) :: any).LegacyCoins).ToBe(
			123456
		)
	end)

	It("a fraction of a Coin is rounded down, so the credit never pays more than was saved", function()
		Expect((Upgrade({ Coins = 12.75, OwnedItems = {}, Stats = { OrbsCollected = 0 } }) :: any).LegacyCoins).ToBe(12)
	end)

	It("nothing to credit leaves no LegacyCoins at all", function()
		for _, Coins in { 0, -5, 0.5, NaN, math.huge, "40", nil :: any } do
			local Data = Upgrade({ Coins = Coins, OwnedItems = {}, Stats = { OrbsCollected = 0 } }) :: any
			Expect(Data.LegacyCoins).ToBeNil()
			Expect(Data.Coins).ToBeNil()
		end
	end)

	It("the current template has no Coins and is version 2", function()
		Expect(Template.SchemaVersion).ToBe(2)
		Expect((Template.Fresh() :: any).Coins).ToBeNil()
		Expect((Template.Fresh() :: any).LegacyCoins).ToBeNil()
	end)

	It("the legacy template is the old version 1 save with Coins, for servers without the ledger", function()
		Expect(Template.LegacyVersion).ToBe(1)
		Expect(Template.LegacyFresh()).ToEqual({
			SchemaVersion = 1,
			Coins = 0,
			OwnedItems = {},
			Stats = { OrbsCollected = 0 },
		})
		Expect(Template.LegacyDefaults).ToEqual(Template.LegacyFresh())
	end)
end)

return nil
