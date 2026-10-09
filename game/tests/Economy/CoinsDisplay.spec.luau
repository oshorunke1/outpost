--!strict
local Harness = require("@Tests/Harness")
local CoinsDisplay = require("@Logic/Economy/CoinsDisplay")
local Packets = require("@Shared/Net/Packets")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

-- selene: allow(divide_by_zero)
local NaN = 0 / 0

local function Pair(...: any): { any }
	return { ... }
end

Describe("CoinsDisplay.For", function()
	It("a player on the old save shows the save's Coins", function()
		Expect(Pair(CoinsDisplay.For("Legacy", 40, 999, false))).ToEqual({ 40, "Ready" })
		Expect(Pair(CoinsDisplay.For("Legacy", nil, 999, true))).ToEqual({ 0, "Ready" })
	end)

	It("a ledger player shows the ledger Coins once joined, and loading before that", function()
		Expect(Pair(CoinsDisplay.For("Ledger", nil, 25, true))).ToEqual({ 25, "Ready" })
		Expect(Pair(CoinsDisplay.For("Ledger", nil, 25, false))).ToEqual({ 0, "Loading" })
	end)

	It("a paused player shows a paused state, never a balance of 0 that looks real", function()
		Expect(Pair(CoinsDisplay.For("Paused", 40, 25, true))).ToEqual({ 0, "Paused" })
		Expect(CoinsDisplay.Text(0, "Paused")).ToBe("Coins paused")
	end)

	It("before the save loads it is loading", function()
		Expect(Pair(CoinsDisplay.For(nil, nil, 0, false))).ToEqual({ 0, "Loading" })
	end)

	It("Coins are whole, never NaN and inside the packet's range", function()
		Expect(Pair(CoinsDisplay.For("Ledger", nil, 12.9, true))).ToEqual({ 12, "Ready" })
		Expect(Pair(CoinsDisplay.For("Ledger", nil, NaN, true))).ToEqual({ 0, "Ready" })
		Expect(Pair(CoinsDisplay.For("Legacy", -5, 0, true))).ToEqual({ 0, "Ready" })
		Expect(Pair(CoinsDisplay.For("Ledger", nil, 1e12, true))).ToEqual({ 1000000000, "Ready" })
	end)
end)

Describe("CoinsDisplay.Text", function()
	It("shows the number only when it is real", function()
		Expect(CoinsDisplay.Text(40, "Ready")).ToBe("Coins 40")
		Expect(CoinsDisplay.Text(0, "Loading")).ToBe("Coins loading")
		Expect(CoinsDisplay.Text(7, "Something else")).ToBe("Coins 7")
	end)

	It("the snapshot packet carries the state", function()
		local Fields = Packets.ByName["Profile.Snapshot"].Payload.Fields
		Expect(Fields.State.Kind).ToBe("String")
		for _, State in { "Ready", "Loading", "Paused" } do
			Expect(#State <= Fields.State.MaxLength).ToBe(true)
		end
	end)
end)

return nil
