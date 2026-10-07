--!strict
local Harness = require("@Tests/Harness")
local SaveSafety = require("@Logic/Data/SaveSafety")
local Template = require("@Logic/Data/Template")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

-- selene: allow(divide_by_zero)
local NaN = 0 / 0

local function DeepTable(Levels: number): { [string]: any }
	local Root: { [string]: any } = {}
	local Node = Root
	for _ = 1, Levels do
		local Child: { [string]: any } = {}
		Node.A = Child
		Node = Child
	end
	return Root
end

local function DeepPath(Levels: number): string
	return "Data" .. string.rep(".A", Levels)
end

local function ProblemOf(Value: any): string
	local Ok, Problem = SaveSafety.Check(Value)
	Expect(Ok).ToBe(false)
	return Problem or ""
end

Describe("SaveSafety.Check", function()
	It("passes plain save data, including a fresh template", function()
		Expect((SaveSafety.Check(Template.Fresh()))).ToBe(true)
		Expect((SaveSafety.Check({ List = { 1, 2, 3 }, Name = "x", Flag = false, Empty = {} }))).ToBe(true)
	end)

	It("names the path of a NaN", function()
		Expect(ProblemOf({ Stats = { OrbsCollected = NaN } })).ToBe("Data.Stats.OrbsCollected is NaN")
	end)

	It("refuses positive and negative infinity", function()
		Expect(ProblemOf({ Coins = math.huge })).ToBe("Data.Coins is infinite")
		Expect(ProblemOf({ Coins = -math.huge })).ToBe("Data.Coins is infinite")
	end)

	It("refuses functions and threads with the list index in the path", function()
		Expect(ProblemOf({ List = { 1, function() end } })).ToBe("Data.List[2] is a function, which cannot be saved")
		Expect(ProblemOf({ Job = coroutine.create(function() end) })).ToBe(
			"Data.Job is a thread, which cannot be saved"
		)
	end)

	It("refuses mixed tables", function()
		-- selene: allow(mixed_table)
		Expect(ProblemOf({ Bag = { 1, Extra = 2 } })).ToBe("Data.Bag mixes list entries and named keys")
	end)

	It("refuses lists with gaps or odd number keys", function()
		Expect(ProblemOf({ Bag = { [1] = "a", [3] = "c" } })).ToBe(
			"Data.Bag has a gap or a key that is not 1, 2, 3 and so on"
		)
		Expect(ProblemOf({ Bag = { [0.5] = "a" } })).ToBe("Data.Bag has a gap or a key that is not 1, 2, 3 and so on")
	end)

	It("refuses keys that are not strings or list numbers", function()
		Expect(ProblemOf({ Bag = { [true] = 1 } })).ToBe("Data.Bag has a boolean key")
	end)

	It("refuses tables with metatables and tables that contain themselves", function()
		Expect(ProblemOf({ Odd = setmetatable({}, {}) })).ToBe("Data.Odd has a metatable")
		local Loop: { [string]: any } = {}
		Loop.Self = Loop
		Expect(ProblemOf({ Loop = Loop })).ToBe("Data.Loop.Self contains itself")
	end)

	It("allows the same table to appear twice, since that is not a loop", function()
		local Shared = { 1, 2 }
		Expect((SaveSafety.Check({ A = Shared, B = Shared }))).ToBe(true)
	end)

	It("reports problems in key order, so the message is stable", function()
		Expect(ProblemOf({ Zed = NaN, Alpha = math.huge })).ToBe("Data.Alpha is infinite")
	end)

	It("refuses text that is not valid UTF-8, in values and in keys", function()
		Expect(ProblemOf({ Name = "\255" })).ToBe("Data.Name is not valid UTF-8")
		Expect(ProblemOf({ Bag = { ["\255"] = 1 } })).ToBe("Data.Bag is not valid UTF-8")
	end)

	It("refuses tables nested past the depth cap", function()
		Expect(ProblemOf(DeepTable(70))).ToBe(DeepPath(65) .. " is nested too deeply")
	end)
end)

Describe("SaveSafety.TryUpdate", function()
	It("applies a safe change and keeps the same table", function()
		local Data = Template.Fresh() :: any
		local Alias = Data
		local Ok = SaveSafety.TryUpdate(Data, function(Draft)
			Draft.Coins += 5
			Draft.OwnedItems.RedHat = true
		end)
		Expect(Ok).ToBe(true)
		Expect(Alias.Coins).ToBe(5)
		Expect(Alias.OwnedItems.RedHat).ToBe(true)
		Expect(Data.Coins).ToBe(5)
		Expect(Data.OwnedItems.RedHat).ToBe(true)
	end)

	It("refuses an unsafe change and leaves the data exactly as it was", function()
		local Data = Template.Fresh() :: any
		local Ok, Problem = SaveSafety.TryUpdate(Data, function(Draft)
			Draft.Coins = NaN
			Draft.Stats.OrbsCollected = 99
		end)
		Expect(Ok).ToBe(false)
		Expect(Problem).ToBe("Data.Coins is NaN")
		Expect(Data).ToEqual(Template.Fresh())
	end)

	It("refuses bad text and deep nesting and leaves the data alone", function()
		local Bad: { (any) -> () } = {
			function(Draft)
				Draft.Name = "\255"
			end,
			function(Draft)
				Draft.Stats["\255"] = 1
			end,
			function(Draft)
				Draft.Deep = DeepTable(70)
			end,
		}
		for _, Mutator in Bad do
			local Data = Template.Fresh() :: any
			local Ok, Problem = SaveSafety.TryUpdate(Data, Mutator)
			Expect(Ok).ToBe(false)
			Expect(Problem ~= nil).ToBe(true)
			Expect(Data).ToEqual(Template.Fresh())
		end
	end)

	It("refuses a change that throws and leaves the data alone", function()
		local Data = Template.Fresh() :: any
		local Ok, Problem = SaveSafety.TryUpdate(Data, function(Draft)
			Draft.Coins = 50
			error("oops")
		end)
		Expect(Ok).ToBe(false)
		Expect(string.find(Problem or "", "oops", 1, true) ~= nil).ToBe(true)
		Expect(Data.Coins).ToBe(0)
	end)
end)

Describe("SaveSafety.DeepCopy", function()
	It("copies nested tables so the copy is independent", function()
		local Original = { Stats = { OrbsCollected = 1 } }
		local Copy = SaveSafety.DeepCopy(Original)
		Copy.Stats.OrbsCollected = 2
		Expect(Original.Stats.OrbsCollected).ToBe(1)
	end)
end)

Describe("SaveSafety.ReplaceContents", function()
	It("keeps the same table, drops old keys and brings in the new values", function()
		local Target: { [string]: any } = { OnlyHere = 1, Shared = "old" }
		local Source: { [string]: any } = { Shared = "new", Extra = { 7 } }
		local Alias = Target
		SaveSafety.ReplaceContents(Target, Source)
		Expect(Alias.Shared).ToBe("new")
		Expect(Alias.OnlyHere).ToBe(nil)
		Expect(Alias.Extra).ToBe(Source.Extra)
		Expect(Target.OnlyHere).ToBe(nil)
		Expect(Target.Shared).ToBe("new")
		Expect(Target.Extra).ToBe(Source.Extra)
	end)
end)

return nil
