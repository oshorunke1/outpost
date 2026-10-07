--!strict
-- A tiny test harness for Lune. Group tests with Describe, write each test with It,
-- and check values with Expect. The Runner collects the results and prints them.

export type Result = { Name: string, Passed: boolean, Message: string? }

local Harness = {}

local Results: { Result } = {}
local Scopes: { string } = {}

local function Show(Value: any): string
	if type(Value) == "string" then
		return string.format("%q", Value)
	end
	return tostring(Value)
end

local function DeepEqual(Left: any, Right: any): boolean
	if Left == Right then
		return true
	end
	if type(Left) ~= "table" or type(Right) ~= "table" then
		return false
	end
	for Key, Value in Left do
		if not DeepEqual(Value, Right[Key]) then
			return false
		end
	end
	for Key in Right do
		if Left[Key] == nil then
			return false
		end
	end
	return true
end

function Harness.Describe(Name: string, Body: () -> ())
	table.insert(Scopes, Name)
	local Ok, Err = pcall(Body)
	table.remove(Scopes)
	if not Ok then
		table.insert(Results, { Name = `{Name} (describe block)`, Passed = false, Message = tostring(Err) })
	end
end

function Harness.It(Name: string, Body: () -> ())
	local Parts = table.clone(Scopes)
	table.insert(Parts, Name)
	local Ok, Err = pcall(Body)
	table.insert(Results, {
		Name = table.concat(Parts, " > "),
		Passed = Ok,
		Message = if Ok then nil else tostring(Err),
	})
end

function Harness.Expect(Actual: any)
	local Matchers = {}

	function Matchers.ToBe(Expected: any)
		if Actual ~= Expected then
			error(`expected {Show(Actual)} to be {Show(Expected)}`, 2)
		end
	end

	function Matchers.ToEqual(Expected: any)
		if not DeepEqual(Actual, Expected) then
			error("expected the tables to be deeply equal", 2)
		end
	end

	function Matchers.ToBeNil()
		if Actual ~= nil then
			error(`expected {Show(Actual)} to be nil`, 2)
		end
	end

	function Matchers.ToBeTruthy()
		if not Actual then
			error(`expected {Show(Actual)} to be truthy`, 2)
		end
	end

	function Matchers.ToBeFalsy()
		if Actual then
			error(`expected {Show(Actual)} to be falsy`, 2)
		end
	end

	-- Text is matched as plain text, so a dot means a dot and not any character.
	function Matchers.ToThrow(Text: string?)
		local Ok, Err = pcall(Actual)
		if Ok then
			error("expected the function to throw", 2)
		end
		if Text ~= nil and string.find(tostring(Err), Text, 1, true) == nil then
			error(`expected an error containing {Show(Text)}, got {Show(tostring(Err))}`, 2)
		end
	end

	return Matchers
end

-- Hands back every result recorded so far and starts a fresh list.
function Harness.TakeResults(): { Result }
	local Taken = Results
	Results = {}
	return Taken
end

-- Puts back a list taken earlier. Only the harness spec needs this.
function Harness.RestoreResults(List: { Result })
	Results = List
end

return Harness
