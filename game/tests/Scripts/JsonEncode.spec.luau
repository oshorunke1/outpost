--!strict
local Harness = require("@Tests/Harness")
local JsonEncode = require("@Scripts/JsonEncode")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

-- selene: allow(divide_by_zero)
local NaN = 0 / 0

Describe("JsonEncode.Encode", function()
	It("writes scalars and ends with one newline", function()
		Expect(JsonEncode.Encode(1)).ToBe("1\n")
		Expect(JsonEncode.Encode(0.25)).ToBe("0.25\n")
		Expect(JsonEncode.Encode(true)).ToBe("true\n")
		Expect(JsonEncode.Encode(JsonEncode.Null)).ToBe("null\n")
		Expect(JsonEncode.Encode("hi")).ToBe('"hi"\n')
	end)

	It("sorts object keys and indents with two spaces", function()
		Expect(JsonEncode.Encode({ b = 1, a = { 2, 3 } })).ToBe('{\n  "a": [\n    2,\n    3\n  ],\n  "b": 1\n}\n')
	end)

	It("writes an empty table as an empty list", function()
		Expect(JsonEncode.Encode({ listens = {} })).ToBe('{\n  "listens": []\n}\n')
	end)

	It("escapes quotes, backslashes and control characters", function()
		Expect(JsonEncode.Encode('a"b\\c\n\1')).ToBe('"a\\"b\\\\c\\n\\u0001"\n')
	end)

	It("gives the same text no matter what order keys were added in", function()
		local First = { z = 1, y = 2, x = 3 }
		local Second = {}
		Second.x = 3
		Second.y = 2
		Second.z = 1
		Expect(JsonEncode.Encode(First)).ToBe(JsonEncode.Encode(Second))
	end)

	It("refuses values JSON cannot hold", function()
		Expect(function()
			JsonEncode.Encode(NaN)
		end).ToThrow("finite")
		Expect(function()
			JsonEncode.Encode(math.huge)
		end).ToThrow("finite")
		Expect(function()
			JsonEncode.Encode(function() end)
		end).ToThrow("function")
		Expect(function()
			JsonEncode.Encode({ [true] = 1 })
		end).ToThrow("keys must be strings")
	end)
end)

return nil
