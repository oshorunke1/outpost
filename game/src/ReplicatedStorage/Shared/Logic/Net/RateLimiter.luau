--!strict
-- A token bucket rate limiter. Each key gets its own bucket that holds up to Capacity tokens.
-- Every allowed action spends one token, and tokens drip back in at RefillPerSecond.
-- The caller passes the time in as Now, so tests can control the clock and this module never touches game.

type Bucket = { Tokens: number, UpdatedAt: number }
type Fields = {
	Capacity: number,
	RefillPerSecond: number,
	Buckets: { [string | number]: Bucket },
}

local RateLimiter = {}
RateLimiter.__index = RateLimiter

export type RateLimiter = typeof(setmetatable({} :: Fields, RateLimiter))

local function IsPositiveFinite(Value: number): boolean
	return type(Value) == "number" and Value == Value and Value > 0 and Value ~= math.huge
end

function RateLimiter.new(Capacity: number, RefillPerSecond: number): RateLimiter
	if not IsPositiveFinite(Capacity) or Capacity < 1 then
		error(`RateLimiter needs a Capacity of at least 1, got {Capacity}`, 2)
	end
	if not IsPositiveFinite(RefillPerSecond) then
		error(`RateLimiter needs a positive, finite RefillPerSecond, got {RefillPerSecond}`, 2)
	end
	local Object: Fields = {
		Capacity = Capacity,
		RefillPerSecond = RefillPerSecond,
		Buckets = {},
	}
	return setmetatable(Object, RateLimiter)
end

-- Returns true and spends a token if the key has one left, otherwise returns false.
function RateLimiter.Allow(self: RateLimiter, Key: string | number, Now: number): boolean
	local Bucket = self.Buckets[Key]
	if Bucket == nil then
		Bucket = { Tokens = self.Capacity, UpdatedAt = Now }
		self.Buckets[Key] = Bucket
	end
	-- If the clock ever goes backwards we treat it as no time passing at all.
	local Elapsed = math.max(0, Now - Bucket.UpdatedAt)
	Bucket.Tokens = math.min(self.Capacity, Bucket.Tokens + Elapsed * self.RefillPerSecond)
	Bucket.UpdatedAt = math.max(Bucket.UpdatedAt, Now)
	if Bucket.Tokens >= 1 then
		Bucket.Tokens -= 1
		return true
	end
	return false
end

-- Drops the bucket for a key, for example when a player leaves, so memory never grows forever.
function RateLimiter.Forget(self: RateLimiter, Key: string | number)
	self.Buckets[Key] = nil
end

-- How many keys currently have a bucket. Tests use this to prove Forget frees memory.
function RateLimiter.TrackedCount(self: RateLimiter): number
	local Count = 0
	for _ in self.Buckets do
		Count += 1
	end
	return Count
end

return RateLimiter
