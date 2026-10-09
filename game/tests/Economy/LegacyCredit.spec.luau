--!strict
local Harness = require("@Tests/Harness")
local EarnBatcher = require("@Logic/Backend/EarnBatcher")
local LegacyCredit = require("@Logic/Economy/LegacyCredit")
local Fs = require("@lune/fs")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

-- selene: allow(divide_by_zero)
local NaN = 0 / 0

local function Sum(List: { number }): number
	local Total = 0
	for _, Coins in List do
		Total += Coins
	end
	return Total
end

Describe("LegacyCredit.Owed", function()
	It("owes the LegacyCoins until the save is marked credited", function()
		Expect(LegacyCredit.Owed({ LegacyCoins = 40 })).ToBe(40)
		Expect(LegacyCredit.Owed({ LegacyCoins = 40, LegacyCredited = false })).ToBe(40)
		Expect(LegacyCredit.Owed({ LegacyCoins = 40, LegacyCredited = true })).ToBeNil()
	end)

	It("owes nothing when there is nothing real to credit", function()
		for _, Bad in { 0, -3, 2.5, NaN, math.huge, "40", true } do
			Expect(LegacyCredit.Owed({ LegacyCoins = Bad :: any })).ToBeNil()
		end
		Expect(LegacyCredit.Owed({})).ToBeNil()
		Expect(LegacyCredit.Owed(nil)).ToBeNil()
	end)
end)

Describe("LegacyCredit.Chunks", function()
	It("splits into chunks of at most 1000 that add up to exactly the balance", function()
		Expect(LegacyCredit.Chunks(40)).ToEqual({ 40 })
		Expect(LegacyCredit.Chunks(1000)).ToEqual({ 1000 })
		Expect(LegacyCredit.Chunks(1001)).ToEqual({ 1000, 1 })
		Expect(LegacyCredit.Chunks(2500)).ToEqual({ 1000, 1000, 500 })
		for _, Coins in { 1, 999, 1000, 1001, 12345, LegacyCredit.MaxCoins } do
			local Chunks = LegacyCredit.Chunks(Coins)
			Expect(Sum(Chunks)).ToBe(Coins)
			for _, Chunk in Chunks do
				Expect(Chunk >= 1 and Chunk <= 1000 and Chunk % 1 == 0).ToBe(true)
			end
		end
	end)

	It("gives the same chunks every time, so a rerun sends the same requests under the same keys", function()
		Expect(LegacyCredit.Chunks(4321)).ToEqual(LegacyCredit.Chunks(4321))
	end)

	It("the chunk size is the backend's earn cap", function()
		Expect(LegacyCredit.ChunkSize).ToBe(EarnBatcher.MaxEarnPerTransaction)
		local Plan = Fs.readFile("../backend/src/modules/economy/plan.ts")
		Expect(tonumber(string.match(Plan, "MAX_EARN_PER_TRANSACTION = (%d+)"))).ToBe(LegacyCredit.ChunkSize)
		Expect(string.find(Plan, "'legacy_migration'", 1, true) ~= nil).ToBe(true)
	end)

	It("refuses an amount that is not a whole number from 1 to MaxCoins", function()
		for _, Bad in { 0, -1, 2.5, NaN, math.huge, LegacyCredit.MaxCoins + 1 } do
			Expect(function()
				LegacyCredit.Chunks(Bad)
			end).ToThrow("legacy")
		end
	end)
end)

Describe("LegacyCredit.Classify", function()
	It("a 201 or a 200 replay is paid", function()
		Expect(LegacyCredit.Classify(201)).ToBe("Paid")
		Expect(LegacyCredit.Classify(200)).ToBe("Paid")
	end)

	It("a 404 means the join has not landed, so the player joins again and the same key goes again", function()
		Expect(LegacyCredit.Classify(404)).ToBe("Rejoin")
	end)

	It("anything temporary is tried later, the same statuses EarnBatcher requeues", function()
		for _, Status in { 0, -1, -2, -3, -5, 401, 403, 408, 425, 429, 500, 503 } do
			Expect(LegacyCredit.Classify(Status)).ToBe("Later")
			Expect(EarnBatcher.ShouldRequeue(Status)).ToBe(true)
		end
	end)

	It("a definite no is refused and never marks the save, so an operator can look", function()
		for _, Status in { 400, 409, 413, 422, -4, 302 } do
			Expect(LegacyCredit.Classify(Status)).ToBe("Refused")
		end
	end)
end)

return nil
