--!strict
-- Small checks for data that comes from players. Every check returns true or false and never errors.
-- FromSpec turns a plain data description (the format Packets uses) into one of these checks,
-- and Describe turns the same description into a one line summary for the framework manifest.

export type Check = (Value: any) -> boolean
export type PayloadSpec = {
	Kind: string,
	Enum: string?,
	Min: number?,
	Max: number?,
	MaxLength: number?,
	Fields: { [string]: PayloadSpec }?,
	Item: PayloadSpec?,
}

local Validate = {}

function Validate.IsFiniteNumber(Value: any): boolean
	return type(Value) == "number" and Value == Value and Value ~= math.huge and Value ~= -math.huge
end

function Validate.IsInteger(Value: any): boolean
	return Validate.IsFiniteNumber(Value) and Value % 1 == 0
end

function Validate.InRange(Value: any, Min: number, Max: number): boolean
	return Validate.IsFiniteNumber(Value) and Value >= Min and Value <= Max
end

-- Enum tables map each id to itself, like { Red = "Red" }, so one lookup is enough.
function Validate.IsEnum(Value: any, EnumTable: { [string]: string }): boolean
	return type(Value) == "string" and EnumTable[Value] == Value
end

function Validate.IsShortString(MaxLength: number): Check
	return function(Value: any): boolean
		return type(Value) == "string" and #Value <= MaxLength and utf8.len(Value) ~= nil
	end
end

-- A table with exactly these keys and nothing else. Extra keys are refused on purpose,
-- so a client can never slip in a field like Price that the server might read by mistake.
function Validate.Struct(Shape: { [string]: Check }): Check
	return function(Value: any): boolean
		if type(Value) ~= "table" or getmetatable(Value) ~= nil then
			return false
		end
		for Key in Value do
			if type(Key) ~= "string" or Shape[Key] == nil then
				return false
			end
		end
		for Key, FieldCheck in Shape do
			if not FieldCheck(Value[Key]) then
				return false
			end
		end
		return true
	end
end

-- A plain list with keys 1, 2, 3 and so on, no gaps, at most MaxLength items, each passing Item.
function Validate.ListOf(Item: Check, MaxLength: number): Check
	return function(Value: any): boolean
		if type(Value) ~= "table" or getmetatable(Value) ~= nil then
			return false
		end
		local Count = 0
		for Key in Value do
			if type(Key) ~= "number" then
				return false
			end
			Count += 1
		end
		if Count > MaxLength then
			return false
		end
		for Index = 1, Count do
			if Value[Index] == nil or not Item(Value[Index]) then
				return false
			end
		end
		return true
	end
end

local function Bounds(Spec: PayloadSpec): (number, number)
	local Min = Spec.Min
	local Max = Spec.Max
	if Min == nil or Max == nil then
		error(`{Spec.Kind} payload spec needs Min and Max`, 3)
	end
	return Min, Max
end

function Validate.FromSpec(Spec: PayloadSpec, Enums: { [string]: { [string]: string } }): Check
	local Kind = Spec.Kind
	if Kind == "None" then
		return function(Value: any): boolean
			return Value == nil
		end
	elseif Kind == "Enum" then
		local EnumName = Spec.Enum or ""
		local EnumTable = Enums[EnumName]
		if EnumTable == nil then
			error(`unknown enum "{EnumName}" in payload spec`, 2)
		end
		return function(Value: any): boolean
			return Validate.IsEnum(Value, EnumTable)
		end
	elseif Kind == "Integer" then
		local Min, Max = Bounds(Spec)
		return function(Value: any): boolean
			return Validate.IsInteger(Value) and Validate.InRange(Value, Min, Max)
		end
	elseif Kind == "Number" then
		local Min, Max = Bounds(Spec)
		return function(Value: any): boolean
			return Validate.InRange(Value, Min, Max)
		end
	elseif Kind == "String" then
		local MaxLength = Spec.MaxLength
		if MaxLength == nil then
			error("String payload spec needs MaxLength", 2)
		end
		return Validate.IsShortString(MaxLength)
	elseif Kind == "Struct" then
		local Fields = Spec.Fields
		if Fields == nil then
			error("Struct payload spec needs Fields", 2)
		end
		local Shape: { [string]: Check } = {}
		for Name, FieldSpec in Fields do
			Shape[Name] = Validate.FromSpec(FieldSpec, Enums)
		end
		return Validate.Struct(Shape)
	elseif Kind == "List" then
		local Item = Spec.Item
		local MaxLength = Spec.MaxLength
		if Item == nil or MaxLength == nil then
			error("List payload spec needs Item and MaxLength", 2)
		end
		return Validate.ListOf(Validate.FromSpec(Item, Enums), MaxLength)
	end
	error(`unknown payload kind "{Kind}"`, 2)
end

function Validate.Describe(Spec: PayloadSpec): string
	local Kind = Spec.Kind
	if Kind == "None" then
		return "none"
	elseif Kind == "Enum" then
		return `enum {Spec.Enum}`
	elseif Kind == "Integer" or Kind == "Number" then
		return `{string.lower(Kind)} {Spec.Min}..{Spec.Max}`
	elseif Kind == "String" then
		return `string up to {Spec.MaxLength} bytes`
	elseif Kind == "Struct" then
		local Fields = (Spec.Fields or {}) :: { [string]: PayloadSpec }
		local Names: { string } = {}
		for Name in Fields do
			table.insert(Names, Name)
		end
		table.sort(Names)
		local Parts: { string } = {}
		for _, Name in Names do
			table.insert(Parts, `{Name}: {Validate.Describe(Fields[Name])}`)
		end
		return `\{ {table.concat(Parts, ", ")} }`
	elseif Kind == "List" then
		local Item = Spec.Item
		local ItemText = if Item then Validate.Describe(Item) else "anything"
		return `list of {ItemText}, up to {Spec.MaxLength}`
	end
	return `unknown {Kind}`
end

return Validate
