--!strict
-- FlagValues merges a flags reply from the backend into the values the game is using.
-- Only flags the game already knows are taken, and only when the value has the same type as the
-- default, so a mistake on the backend can never turn ShopEnabled into a string.
-- A known flag with a bad value goes back to its default, because the backend meant to change it
-- and the safe guess is the value the game ships with.
-- A flag the reply leaves out keeps its last known value, and so does everything when the reply
-- is missing or broken. That is how the game rides out a backend outage.

export type Response = { Ok: boolean, Status: number, Body: any }

local FlagValues = {}

local function IsGood(Value: any, Default: any): boolean
	if type(Value) ~= type(Default) then
		return false
	end
	if type(Value) == "number" then
		return Value == Value and Value ~= math.huge and Value ~= -math.huge
	end
	return true
end

-- Gives a fresh table with exactly the flags in Defaults.
function FlagValues.Merge(Defaults: any, Current: { [string]: any }, Incoming: any): { [string]: any }
	local Merged: { [string]: any } = {}
	local Reply = if type(Incoming) == "table" then Incoming else {}
	for Key, Default in pairs(Defaults) do
		local Value = Reply[Key]
		local Last = Current[Key]
		if Value ~= nil then
			Merged[Key] = if IsGood(Value, Default) then Value else Default
		else
			Merged[Key] = if IsGood(Last, Default) then Last else Default
		end
	end
	return Merged
end

-- Merges the flags from a GET /v1/flags answer. Anything but a 200 with a flags table, a 503
-- flags_unavailable included, keeps the last known values.
function FlagValues.FromResponse(Defaults: any, Current: { [string]: any }, Response: Response): { [string]: any }
	local Body = Response.Body
	if Response.Status ~= 200 or type(Body) ~= "table" or type(Body.flags) ~= "table" then
		return FlagValues.Merge(Defaults, Current, nil)
	end
	return FlagValues.Merge(Defaults, Current, Body.flags)
end

return FlagValues
