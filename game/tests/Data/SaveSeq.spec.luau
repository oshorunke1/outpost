--!strict
local Harness = require("@Tests/Harness")
local SaveSeq = require("@Logic/Data/SaveSeq")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

-- selene: allow(divide_by_zero)
local NaN = 0 / 0

Describe("SaveSeq", function()
	It("the next number is one more than the tag the profile holds now", function()
		Expect(SaveSeq.Next({})).ToBe(1)
		Expect(SaveSeq.Next({ [SaveSeq.Tag] = 4 })).ToBe(5)
	end)

	It("a missing or broken tag starts again from 1", function()
		for _, Bad in { "4", NaN, -3, 2.5, math.huge, true } do
			Expect(SaveSeq.Next({ [SaveSeq.Tag] = Bad :: any })).ToBe(1)
		end
		Expect(SaveSeq.Next(nil)).ToBe(1)
	end)

	It("only a save that carried our number or a later one counts as ours", function()
		Expect(SaveSeq.Landed({ [SaveSeq.Tag] = 5 }, 5)).ToBe(true)
		Expect(SaveSeq.Landed({ [SaveSeq.Tag] = 6 }, 5)).ToBe(true)
		-- A save that started before we bumped the number still carries the old one.
		Expect(SaveSeq.Landed({ [SaveSeq.Tag] = 4 }, 5)).ToBe(false)
		Expect(SaveSeq.Landed({}, 5)).ToBe(false)
		Expect(SaveSeq.Landed(nil, 5)).ToBe(false)
		Expect(SaveSeq.Landed({ [SaveSeq.Tag] = NaN }, 5)).ToBe(false)
		Expect(SaveSeq.Landed({ [SaveSeq.Tag] = "9" :: any }, 5)).ToBe(false)
	end)
end)

return nil
