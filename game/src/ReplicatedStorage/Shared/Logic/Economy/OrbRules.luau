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

-- The flag can speed orbs up or slow them down, but only between a quarter and four times.
OrbRules.MinRespawnMultiplier = 0.25
OrbRules.MaxRespawnMultiplier = 4

-- How long a new orb takes to appear. The OrbSpawnMultiplier flag divides the base wait, and
-- anything that is not a sensible positive number means the normal wait.
function OrbRules.RespawnDelay(BaseSeconds: number, Multiplier: any): number
	if type(Multiplier) ~= "number" or not IsFinite(Multiplier) or Multiplier <= 0 then
		return BaseSeconds
	end
	return BaseSeconds / math.clamp(Multiplier, OrbRules.MinRespawnMultiplier, OrbRules.MaxRespawnMultiplier)
end

return OrbRules
