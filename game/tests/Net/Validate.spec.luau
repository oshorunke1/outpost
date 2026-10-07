--!strict
local Harness = require("@Tests/Harness")
local Validate = require("@Logic/Net/Validate")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

-- selene: allow(divide_by_zero)
local NaN = 0 / 0
local Colors = table.freeze({ Red = "Red", Blue = "Blue" })
local Enums = { Color = Colors }

Describe("Validate basic checks", function()
	It("IsFiniteNumber accepts real numbers only", function()
		Expect(Validate.IsFiniteNumber(1)).ToBe(true)
		Expect(Validate.IsFiniteNumber(-3.5)).ToBe(true)
		Expect(Validate.IsFiniteNumber(NaN)).ToBe(false)
		Expect(Validate.IsFiniteNumber(math.huge)).ToBe(false)
		Expect(Validate.IsFiniteNumber(-math.huge)).ToBe(false)
		Expect(Validate.IsFiniteNumber("1")).ToBe(false)
		Expect(Validate.IsFiniteNumber(nil)).ToBe(false)
	end)

	It("IsInteger accepts whole finite numbers only", function()
		Expect(Validate.IsInteger(4)).ToBe(true)
		Expect(Validate.IsInteger(4.5)).ToBe(false)
		Expect(Validate.IsInteger(math.huge)).ToBe(false)
	end)

	It("InRange is inclusive and refuses NaN", function()
		Expect(Validate.InRange(1, 1, 3)).ToBe(true)
		Expect(Validate.InRange(3, 1, 3)).ToBe(true)
		Expect(Validate.InRange(3.01, 1, 3)).ToBe(false)
		Expect(Validate.InRange(NaN, 1, 3)).ToBe(false)
	end)

	It("IsEnum only accepts listed ids", function()
		Expect(Validate.IsEnum("Red", Colors)).ToBe(true)
		Expect(Validate.IsEnum("Green", Colors)).ToBe(false)
		Expect(Validate.IsEnum(1, Colors)).ToBe(false)
		Expect(Validate.IsEnum(nil, Colors)).ToBe(false)
	end)

	It("IsShortString checks type, byte length and UTF-8", function()
		local Check = Validate.IsShortString(5)
		Expect(Check("hello")).ToBe(true)
		Expect(Check("")).ToBe(true)
		Expect(Check("hello!")).ToBe(false)
		Expect(Check(5)).ToBe(false)
		Expect(Check("\255")).ToBe(false)
	end)
end)

Describe("Validate.Struct", function()
	local Check = Validate.Struct({
		ItemId = function(Value)
			return Validate.IsEnum(Value, Colors)
		end,
	})

	It("accepts a table with exactly the listed keys", function()
		Expect(Check({ ItemId = "Red" })).ToBe(true)
	end)

	It("refuses a missing or bad field", function()
		Expect(Check({})).ToBe(false)
		Expect(Check({ ItemId = "Green" })).ToBe(false)
	end)

	It("refuses extra keys, so a forged Price never sneaks through", function()
		Expect(Check({ ItemId = "Red", Price = 0 })).ToBe(false)
		Expect(Check({ ItemId = "Red", [1] = "x" })).ToBe(false)
	end)

	It("refuses things that are not plain tables", function()
		Expect(Check("Red")).ToBe(false)
		Expect(Check(nil)).ToBe(false)
		Expect(Check(setmetatable({ ItemId = "Red" }, {}))).ToBe(false)
	end)
end)

Describe("Validate.ListOf", function()
	local Check = Validate.ListOf(Validate.IsShortString(8), 2)

	It("accepts a short list of good items", function()
		Expect(Check({})).ToBe(true)
		Expect(Check({ "a", "b" })).ToBe(true)
	end)

	It("refuses long lists, gaps, named keys and bad items", function()
		Expect(Check({ "a", "b", "c" })).ToBe(false)
		Expect(Check({ [1] = "a", [3] = "c" })).ToBe(false)
		Expect(Check({ A = "a" })).ToBe(false)
		Expect(Check({ 5 })).ToBe(false)
	end)
end)

Describe("Validate.FromSpec", function()
	It("builds checks for every kind", function()
		Expect(Validate.FromSpec({ Kind = "None" }, Enums)(nil)).ToBe(true)
		Expect(Validate.FromSpec({ Kind = "None" }, Enums)({})).ToBe(false)
		Expect(Validate.FromSpec({ Kind = "Enum", Enum = "Color" }, Enums)("Blue")).ToBe(true)
		local Whole = Validate.FromSpec({ Kind = "Integer", Min = 1, Max = 10 }, Enums)
		Expect(Whole(10)).ToBe(true)
		Expect(Whole(2.5)).ToBe(false)
		Expect(Whole(11)).ToBe(false)
		local Real = Validate.FromSpec({ Kind = "Number", Min = 0, Max = 1 }, Enums)
		Expect(Real(0.5)).ToBe(true)
		Expect(Real(NaN)).ToBe(false)
		Expect(Validate.FromSpec({ Kind = "String", MaxLength = 3 }, Enums)("abcd")).ToBe(false)
		local Struct = Validate.FromSpec({
			Kind = "Struct",
			Fields = { Color = { Kind = "Enum", Enum = "Color" }, Count = { Kind = "Integer", Min = 0, Max = 5 } },
		}, Enums)
		Expect(Struct({ Color = "Red", Count = 2 })).ToBe(true)
		Expect(Struct({ Color = "Red", Count = 2, Extra = true })).ToBe(false)
		local List =
			Validate.FromSpec({ Kind = "List", MaxLength = 2, Item = { Kind = "Enum", Enum = "Color" } }, Enums)
		Expect(List({ "Red", "Blue" })).ToBe(true)
		Expect(List({ "Red", "Pink" })).ToBe(false)
	end)

	It("fails loudly at build time on a broken spec", function()
		Expect(function()
			Validate.FromSpec({ Kind = "Blob" }, Enums)
		end).ToThrow("unknown payload kind")
		Expect(function()
			Validate.FromSpec({ Kind = "Enum", Enum = "Shape" }, Enums)
		end).ToThrow("unknown enum")
		Expect(function()
			Validate.FromSpec({ Kind = "Integer", Min = 1 }, Enums)
		end).ToThrow("Min and Max")
		Expect(function()
			Validate.FromSpec({ Kind = "Struct" }, Enums)
		end).ToThrow("Fields")
	end)
end)

Describe("Validate.Describe", function()
	It("writes a short, stable summary with fields in name order", function()
		Expect(Validate.Describe({ Kind = "None" })).ToBe("none")
		Expect(Validate.Describe({ Kind = "Integer", Min = 1, Max = 10 })).ToBe("integer 1..10")
		Expect(Validate.Describe({ Kind = "Number", Min = 0, Max = 0.5 })).ToBe("number 0..0.5")
		Expect(Validate.Describe({ Kind = "String", MaxLength = 32 })).ToBe("string up to 32 bytes")
		Expect(Validate.Describe({
			Kind = "Struct",
			Fields = { Zeta = { Kind = "Enum", Enum = "Color" }, Alpha = { Kind = "None" } },
		})).ToBe("{ Alpha: none, Zeta: enum Color }")
		Expect(Validate.Describe({ Kind = "List", MaxLength = 4, Item = { Kind = "Enum", Enum = "Color" } })).ToBe(
			"list of enum Color, up to 4"
		)
	end)
end)

return nil
