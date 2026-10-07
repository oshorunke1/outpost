--!strict
-- A tiny JSON writer for the framework manifest. Object keys come out sorted, indents are two
-- spaces, and the text ends with exactly one newline, so the output only changes when the data does.
-- That matters because CI regenerates the manifest and fails if a single byte differs.

local JsonEncode = {}

-- Put this in a table where JSON should say null, since a Luau table cannot hold nil.
JsonEncode.Null = table.freeze({})

local Escapes: { [string]: string } = {
	['"'] = '\\"',
	["\\"] = "\\\\",
	["\n"] = "\\n",
	["\r"] = "\\r",
	["\t"] = "\\t",
}

local function EncodeString(Text: string): string
	local Escaped = string.gsub(Text, '[%c"\\]', function(Char: string): string
		return Escapes[Char] or string.format("\\u%04x", string.byte(Char))
	end)
	return `"{Escaped}"`
end

local function EncodeNumber(Value: number): string
	if Value ~= Value or Value == math.huge or Value == -math.huge then
		error("JSON numbers must be finite", 0)
	end
	if Value % 1 == 0 and math.abs(Value) < 2 ^ 53 then
		return string.format("%d", Value)
	end
	return string.format("%.14g", Value)
end

local function IsList(Value: { [any]: any }): boolean
	local Count = 0
	for Key in Value do
		if type(Key) ~= "number" then
			return false
		end
		Count += 1
	end
	for Index = 1, Count do
		if Value[Index] == nil then
			return false
		end
	end
	return true
end

local function EncodeValue(Value: any, Depth: number): string
	if Value == JsonEncode.Null then
		return "null"
	end
	local Kind = type(Value)
	if Kind == "string" then
		return EncodeString(Value)
	elseif Kind == "number" then
		return EncodeNumber(Value)
	elseif Kind == "boolean" then
		return if Value then "true" else "false"
	elseif Kind ~= "table" then
		error(`cannot write a {Kind} as JSON`, 0)
	end

	local Pad = string.rep("  ", Depth + 1)
	local ClosingPad = string.rep("  ", Depth)
	local Parts: { string } = {}
	if IsList(Value) then
		if #Value == 0 then
			return "[]"
		end
		for _, Item in ipairs(Value) do
			table.insert(Parts, Pad .. EncodeValue(Item, Depth + 1))
		end
		return "[\n" .. table.concat(Parts, ",\n") .. "\n" .. ClosingPad .. "]"
	end

	local Keys: { string } = {}
	for Key in Value do
		if type(Key) ~= "string" then
			error(`JSON object keys must be strings, got a {type(Key)}`, 0)
		end
		table.insert(Keys, Key)
	end
	table.sort(Keys)
	for _, Key in Keys do
		table.insert(Parts, `{Pad}{EncodeString(Key)}: {EncodeValue(Value[Key], Depth + 1)}`)
	end
	return "{\n" .. table.concat(Parts, ",\n") .. "\n" .. ClosingPad .. "}"
end

function JsonEncode.Encode(Value: any): string
	return EncodeValue(Value, 0) .. "\n"
end

return JsonEncode
