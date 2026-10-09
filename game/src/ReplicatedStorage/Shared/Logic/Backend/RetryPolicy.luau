--!strict
-- RetryPolicy decides whether a failed backend call is worth another try and how long to wait first.
-- It uses exponential backoff with full jitter, so many servers retrying at once spread out.
-- The caller passes in a random number from 0 to 1, so tests can pick it and this module never touches game.
-- When the server sends a Retry-After header the wait honours it, up to MaxRetryAfter seconds, and
-- adds our own jittered backoff on top so a crowd of servers told the same thing spreads out.

export type Policy = { MaxAttempts: number, BaseDelay: number, MaxDelay: number }

local RetryPolicy = {}

RetryPolicy.Default = table.freeze({ MaxAttempts = 3, BaseDelay = 0.5, MaxDelay = 4 }) :: Policy

-- The longest a server can make us wait between two tries. Anything longer is cut down to this.
RetryPolicy.MaxRetryAfter = 30

-- Status 0 means no answer came back at all, like a timeout or a dropped connection.
-- Statuses below zero are refusals made on this server, such as an open breaker, and are never retried.
local Retryable: { [number]: boolean } = {
	[0] = true,
	[408] = true,
	[425] = true,
	[429] = true,
	[500] = true,
	[502] = true,
	[503] = true,
	[504] = true,
}

function RetryPolicy.IsRetryable(Status: number): boolean
	return Retryable[Status] == true
end

-- Attempt counts the tries made so far, starting at 1.
function RetryPolicy.ShouldRetry(Policy: Policy, Attempt: number, Status: number): boolean
	return Attempt < Policy.MaxAttempts and RetryPolicy.IsRetryable(Status)
end

-- Picks a wait anywhere from 0 up to this attempt's backoff, which doubles each time and is capped.
-- RetryAfter is the server's own wait in seconds, if it sent one. It is cut down to MaxRetryAfter.
-- When it is longer than our backoff we wait for it and then our backoff too, so servers that got the
-- same answer at the same moment do not all retry at the same instant. Otherwise the backoff wins.
-- The longest wait is MaxRetryAfter plus MaxDelay.
function RetryPolicy.DelayFor(Policy: Policy, Attempt: number, RandomUnit: number, RetryAfter: number?): number
	local Unit = RandomUnit
	if Unit ~= Unit or Unit < 0 then
		Unit = 0
	elseif Unit > 1 then
		Unit = 1
	end
	local Tries = Attempt
	if Tries ~= Tries or Tries < 1 then
		Tries = 1
	end
	local Ceiling = math.min(Policy.MaxDelay, Policy.BaseDelay * 2 ^ (Tries - 1))
	local Backoff = Unit * Ceiling
	if RetryAfter == nil or RetryAfter ~= RetryAfter or RetryAfter < 0 then
		return Backoff
	end
	local ServerWait = math.min(RetryAfter, RetryPolicy.MaxRetryAfter)
	if ServerWait <= Backoff then
		return Backoff
	end
	return ServerWait + Backoff
end

-- Turns a Retry-After header value into seconds. Only plain whole seconds such as "7" are understood.
-- The date form and anything odd give nil, so the caller just falls back to its own backoff.
function RetryPolicy.ParseRetryAfter(Value: string?): number?
	if type(Value) ~= "string" then
		return nil
	end
	local Digits = string.match(Value, "^%s*(%d+)%s*$")
	if Digits == nil or #Digits > 9 then
		return nil
	end
	return tonumber(Digits)
end

return RetryPolicy
