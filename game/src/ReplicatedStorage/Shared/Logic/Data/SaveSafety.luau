--!strict
-- Checks that a value can be saved to a DataStore without breaking it.
-- DataStores choke on NaN, infinity, functions, mixed tables and odd keys, and a bad save can
-- wipe a player's data. Check finds the first problem and says exactly where it is.
-- TryUpdate is how DataService changes a save, so a bad change is refused before it ever lands.

local SaveSafety = {}

local ListKeyProblem = "has a gap or a key that is not 1, 2, 3 and so on"

local function CheckValue(Value: any, Path: string, Visiting: { [any]: boolean }): string?
	local Kind = type(Value)
	if Kind == "boolean" or Kind == "string" then
		return nil
	end
	if Kind == "number" then
		if Value ~= Value then
			return `{Path} is NaN`
		end
		if Value == math.huge or Value == -math.huge then
			return `{Path} is infinite`
		end
		return nil
	end
	if Kind ~= "table" then
		return `{Path} is a {Kind}, which cannot be saved`
	end
	if Visiting[Value] then
		return `{Path} contains itself`
	end
	if getmetatable(Value) ~= nil then
		return `{Path} has a metatable`
	end

	local Count = 0
	local HasNumberKey = false
	local HasStringKey = false
	for Key in Value do
		Count += 1
		local KeyKind = type(Key)
		if KeyKind == "string" then
			HasStringKey = true
		elseif KeyKind == "number" then
			HasNumberKey = true
		else
			return `{Path} has a {KeyKind} key`
		end
	end
	if HasNumberKey and HasStringKey then
		return `{Path} mixes list entries and named keys`
	end

	-- Visiting only holds the tables on the current path, so a table used twice is fine but a loop is not.
	Visiting[Value] = true
	local Problem: string? = nil
	if HasNumberKey then
		for Index = 1, Count do
			if Value[Index] == nil then
				Problem = `{Path} {ListKeyProblem}`
				break
			end
		end
		if Problem == nil then
			for Index = 1, Count do
				Problem = CheckValue(Value[Index], `{Path}[{Index}]`, Visiting)
				if Problem then
					break
				end
			end
		end
	else
		local Keys: { string } = {}
		for Key in Value do
			table.insert(Keys, Key)
		end
		table.sort(Keys)
		for _, Key in Keys do
			Problem = CheckValue(Value[Key], `{Path}.{Key}`, Visiting)
			if Problem then
				break
			end
		end
	end
	Visiting[Value] = nil
	return Problem
end

function SaveSafety.Check(Value: any): (boolean, string?)
	local Problem = CheckValue(Value, "Data", {})
	return Problem == nil, Problem
end

function SaveSafety.DeepCopy<T>(Value: T): T
	if type(Value) ~= "table" then
		return Value
	end
	local Copy = {}
	for Key, Inner in Value :: any do
		Copy[SaveSafety.DeepCopy(Key)] = SaveSafety.DeepCopy(Inner)
	end
	return Copy :: any
end

-- Empties Target and fills it with whatever Source holds, keeping Target as the same table
-- so anything that already points at it (like ProfileService) still sees the new contents.
function SaveSafety.ReplaceContents(Target: { [string]: any }, Source: { [string]: any })
	for Key in Target do
		Target[Key] = nil
	end
	for Key, Value in Source do
		Target[Key] = Value
	end
end

-- Runs Mutator on a copy of Data. If the copy is still safe to save, its contents are moved
-- into Data, keeping the same table so ProfileService still points at it. Otherwise Data is untouched.
function SaveSafety.TryUpdate(Data: { [string]: any }, Mutator: (Draft: any) -> ()): (boolean, string?)
	local Draft = SaveSafety.DeepCopy(Data)
	local Ran, Err = pcall(Mutator :: (any) -> any, Draft)
	if not Ran then
		return false, `the update threw an error, {Err}`
	end
	local Safe, Problem = SaveSafety.Check(Draft)
	if not Safe then
		return false, Problem
	end
	SaveSafety.ReplaceContents(Data, Draft)
	return true, nil
end

return SaveSafety
