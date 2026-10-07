--!strict
-- The rules for picking up an orb. The server measures the distance itself and passes it in,
-- so a client claiming it touched an orb across the map gets refused.

export type Attempt = { OrbExists: boolean, Distance: number, Now: number, LastCollectAt: number? }
export type Refusal = "NoSuchOrb" | "NoPosition" | "TooFar" | "Cooldown"

local OrbRules = {}

OrbRules.MaxDistance = 12
OrbRules.CooldownSeconds = 0.2
OrbRules.CoinsPerOrb = 5

-- NaN is never bigger or smaller than anything, so it would sail past the distance and cooldown
-- comparisons below. That is why every number gets checked up front and a bad one is refused.
local function IsFinite(Value: number): boolean
	return Value == Value and Value ~= math.huge and Value ~= -math.huge
end

function OrbRules.CanCollect(Attempt: Attempt): (boolean, Refusal?)
	if not Attempt.OrbExists then
		return false, "NoSuchOrb"
	end
	local Distance = Attempt.Distance
	-- A missing character shows up as a huge or NaN distance, and that must never count as close.
	if not IsFinite(Distance) or Distance < 0 then
		return false, "NoPosition"
	end
	if Distance > OrbRules.MaxDistance then
		return false, "TooFar"
	end
	local Last = Attempt.LastCollectAt
	if not IsFinite(Attempt.Now) or (Last ~= nil and not IsFinite(Last)) then
		return false, "Cooldown"
	end
	if Last ~= nil and Attempt.Now - Last < OrbRules.CooldownSeconds then
		return false, "Cooldown"
	end
	return true, nil
end

return OrbRules
