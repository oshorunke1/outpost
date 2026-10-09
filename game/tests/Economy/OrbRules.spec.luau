--!strict
local Harness = require("@Tests/Harness")
local OrbRules = require("@Logic/Economy/OrbRules")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

-- selene: allow(divide_by_zero)
local NaN = 0 / 0

local function Try(Distance: number, Now: number, LastCollectAt: number?, OrbExists: boolean?): (boolean, string?)
	return OrbRules.CanCollect({
		OrbExists = if OrbExists == nil then true else OrbExists,
		Distance = Distance,
		Now = Now,
		LastCollectAt = LastCollectAt,
	})
end

Describe("OrbRules.CanCollect", function()
	It("allows a close pickup with no cooldown running", function()
		Expect((Try(3, 10, nil))).ToBe(true)
	end)

	It("allows a pickup exactly at MaxDistance and refuses one just past it", function()
		Expect((Try(OrbRules.MaxDistance, 10, nil))).ToBe(true)
		local Ok, Reason = Try(OrbRules.MaxDistance + 0.01, 10, nil)
		Expect(Ok).ToBe(false)
		Expect(Reason).ToBe("TooFar")
	end)

	It("refuses an orb that does not exist, for example one already taken", function()
		local Ok, Reason = Try(1, 10, nil, false)
		Expect(Ok).ToBe(false)
		Expect(Reason).ToBe("NoSuchOrb")
	end)

	It("refuses a non-finite distance, which is what a missing character looks like", function()
		Expect(select(2, Try(math.huge, 10, nil))).ToBe("NoPosition")
		Expect(select(2, Try(NaN, 10, nil))).ToBe("NoPosition")
		Expect(select(2, Try(-1, 10, nil))).ToBe("NoPosition")
	end)

	It("refuses a NaN distance", function()
		Expect(select(2, Try(NaN, 10, nil))).ToBe("NoPosition")
	end)

	It("refuses an infinite distance", function()
		Expect(select(2, Try(math.huge, 10, nil))).ToBe("NoPosition")
	end)

	It("refuses a negative distance", function()
		Expect(select(2, Try(-1, 10, nil))).ToBe("NoPosition")
	end)

	It("refuses a NaN clock reading", function()
		Expect(select(2, Try(1, NaN, nil))).ToBe("Cooldown")
	end)

	It("refuses a NaN last pickup time", function()
		Expect(select(2, Try(1, 10, NaN))).ToBe("Cooldown")
	end)

	It("enforces the cooldown between pickups", function()
		Expect(select(2, Try(1, 10.1, 10))).ToBe("Cooldown")
		Expect((Try(1, 10.5, 10))).ToBe(true)
	end)

	It("treats a clock that went backwards as still cooling down", function()
		Expect(select(2, Try(1, 5, 10))).ToBe("Cooldown")
	end)

	It("pays a whole, positive number of coins per orb", function()
		Expect(OrbRules.CoinsPerOrb >= 1 and OrbRules.CoinsPerOrb % 1 == 0).ToBe(true)
	end)
end)

Describe("OrbRules.RespawnDelay", function()
	It("scales with the flag and clamps it", function()
		Expect(OrbRules.RespawnDelay(3, 1)).ToBe(3)
		Expect(OrbRules.RespawnDelay(3, 2)).ToBe(1.5)
		Expect(OrbRules.RespawnDelay(3, 4)).ToBe(0.75)
		Expect(OrbRules.RespawnDelay(3, 100)).ToBe(0.75)
		Expect(OrbRules.RespawnDelay(3, 0.25)).ToBe(12)
		Expect(OrbRules.RespawnDelay(3, 0.01)).ToBe(12)
	end)

	It("ignores a broken multiplier", function()
		for _, Bad in { NaN, 0, -2, math.huge, -math.huge, "2", true } :: { any } do
			Expect(OrbRules.RespawnDelay(3, Bad)).ToBe(3)
		end
		Expect(OrbRules.RespawnDelay(3, nil)).ToBe(3)
	end)
end)

return nil
