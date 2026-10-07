--!strict
local Harness = require("@Tests/Harness")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

-- Runs one test body on its own and hands back what it recorded, without touching the real results.
local function RunAlone(Body: () -> ()): Harness.Result
	local Saved = Harness.TakeResults()
	Harness.It("inner", Body)
	local Inner = Harness.TakeResults()
	Harness.RestoreResults(Saved)
	return Inner[1]
end

local function MessageHas(Result: Harness.Result, Text: string): boolean
	return string.find(Result.Message or "", Text, 1, true) ~= nil
end

Describe("Harness", function()
	It("ToBe passes on equal values", function()
		Expect(3).ToBe(3)
		Expect("A").ToBe("A")
	end)

	It("ToBe fails and names both values", function()
		local Result = RunAlone(function()
			Expect(1).ToBe(2)
		end)
		Expect(Result.Passed).ToBe(false)
		Expect(MessageHas(Result, "expected 1 to be 2")).ToBe(true)
	end)

	It("ToEqual compares nested tables by value", function()
		Expect({ A = 1, B = { 2, 3 } }).ToEqual({ A = 1, B = { 2, 3 } })
	end)

	It("ToEqual fails when the actual table has an extra key", function()
		local Result = RunAlone(function()
			Expect({ A = 1, B = 2 }).ToEqual({ A = 1 })
		end)
		Expect(Result.Passed).ToBe(false)
		Expect(MessageHas(Result, "deeply equal")).ToBe(true)
	end)

	It("ToBeNil, ToBeTruthy and ToBeFalsy check what they say", function()
		Expect(nil).ToBeNil()
		Expect(0).ToBeTruthy()
		Expect(false).ToBeFalsy()
		Expect(RunAlone(function()
			Expect("x").ToBeNil()
		end).Passed).ToBe(false)
		Expect(RunAlone(function()
			Expect(nil).ToBeTruthy()
		end).Passed).ToBe(false)
	end)

	It("ToThrow matches plain text so dots are literal", function()
		Expect(function()
			error("Shop.Buy is sealed")
		end).ToThrow("Shop.Buy")
		local Result = RunAlone(function()
			Expect(function()
				error("ShopXBuy")
			end).ToThrow("Shop.Buy")
		end)
		Expect(Result.Passed).ToBe(false)
	end)

	It("ToThrow fails when nothing is thrown", function()
		local Result = RunAlone(function()
			Expect(function() end).ToThrow()
		end)
		Expect(MessageHas(Result, "expected the function to throw")).ToBe(true)
	end)

	It("a failing It is recorded and the next It still runs", function()
		local Saved = Harness.TakeResults()
		Harness.It("breaks", function()
			error("inner failure")
		end)
		Harness.It("still runs", function() end)
		local Inner = Harness.TakeResults()
		Harness.RestoreResults(Saved)
		Expect(#Inner).ToBe(2)
		Expect(Inner[1].Passed).ToBe(false)
		Expect(MessageHas(Inner[1], "inner failure")).ToBe(true)
		Expect(Inner[2].Passed).ToBe(true)
	end)

	It("joins nested Describe names with arrows", function()
		local Saved = Harness.TakeResults()
		Describe("Outer", function()
			Describe("Inner", function()
				It("leaf", function() end)
			end)
		end)
		local Inner = Harness.TakeResults()
		Harness.RestoreResults(Saved)
		Expect(Inner[1].Name).ToBe("Harness > Outer > Inner > leaf")
	end)
end)

return nil
