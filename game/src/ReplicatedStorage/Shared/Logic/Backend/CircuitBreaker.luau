--!strict
-- CircuitBreaker stops calling the backend for a while after it keeps failing, so a dead backend
-- costs one quick refusal instead of a slow timeout on every call.
-- Closed lets everything through. After FailureThreshold failures in a row it opens and refuses
-- everything for OpenSeconds. Then it goes half open and lets exactly one probe call through.
-- If the probe works it closes again, and if the probe fails it opens again.
-- A probe that never reports back is given up on after another OpenSeconds, so it can never get stuck.
-- The caller passes the time in as Now, the same way RateLimiter does.
-- A Now that is NaN or infinite is ignored, so a broken clock can never open, close or unlock it.
-- Only no answer at all and 5xx errors count as failures. A 429 means the backend is alive and
-- asking us to slow down, so it never opens the breaker. Use RecordResult to get that sorting for free.
-- A 408 or 425 is neutral. The backend answered but did no work, so it neither counts as a failure
-- nor proves the backend healthy enough to close a half open breaker.

export type State = "Closed" | "Open" | "HalfOpen"

type Fields = {
	FailureThreshold: number,
	OpenSeconds: number,
	Current: State,
	Failures: number,
	OpenedAt: number,
	ProbeStartedAt: number?,
}

local CircuitBreaker = {}
CircuitBreaker.__index = CircuitBreaker

export type CircuitBreaker = typeof(setmetatable({} :: Fields, CircuitBreaker))

local function IsFinite(Value: number): boolean
	return type(Value) == "number" and Value == Value and Value ~= math.huge and Value ~= -math.huge
end

function CircuitBreaker.new(FailureThreshold: number, OpenSeconds: number): CircuitBreaker
	if not IsFinite(FailureThreshold) or FailureThreshold < 1 or FailureThreshold % 1 ~= 0 then
		error(`CircuitBreaker needs a whole FailureThreshold of at least 1, got {FailureThreshold}`, 2)
	end
	if not IsFinite(OpenSeconds) or OpenSeconds <= 0 then
		error(`CircuitBreaker needs a positive, finite OpenSeconds, got {OpenSeconds}`, 2)
	end
	local Object: Fields = {
		FailureThreshold = FailureThreshold,
		OpenSeconds = OpenSeconds,
		Current = "Closed",
		Failures = 0,
		OpenedAt = 0,
		ProbeStartedAt = nil,
	}
	return setmetatable(Object, CircuitBreaker)
end

-- True when a backend call should count against the breaker. That is status 0, meaning no answer
-- came back, or any 5xx. Successes, 4xx answers including 429, and local refusals below zero do not.
function CircuitBreaker.CountsAsFailure(Status: number): boolean
	return Status == 0 or (Status >= 500 and Status <= 599)
end

-- True for the answers that say nothing either way, a request timeout (408) and too early (425).
function CircuitBreaker.IsNeutral(Status: number): boolean
	return Status == 408 or Status == 425
end

function CircuitBreaker.Allow(self: CircuitBreaker, Now: number): boolean
	if self.Current == "Closed" then
		return true
	end
	if not IsFinite(Now) then
		return false
	end
	if self.Current == "Open" then
		if Now - self.OpenedAt < self.OpenSeconds then
			return false
		end
		self.Current = "HalfOpen"
		self.ProbeStartedAt = nil
	end
	local Started = self.ProbeStartedAt
	if Started ~= nil and Now - Started < self.OpenSeconds then
		return false
	end
	self.ProbeStartedAt = Now
	return true
end

-- A success closes the breaker even while it is open. That covers a call that was already in flight
-- when the breaker opened and then got a real answer, which proves the backend is up after all.
function CircuitBreaker.RecordSuccess(self: CircuitBreaker, _Now: number)
	self.Current = "Closed"
	self.Failures = 0
	self.ProbeStartedAt = nil
end

function CircuitBreaker.RecordFailure(self: CircuitBreaker, Now: number)
	if not IsFinite(Now) or self.Current == "Open" then
		return
	end
	if self.Current == "HalfOpen" then
		self.Current = "Open"
		self.OpenedAt = Now
		self.ProbeStartedAt = nil
		return
	end
	self.Failures += 1
	if self.Failures >= self.FailureThreshold then
		self.Current = "Open"
		self.OpenedAt = Now
	end
end

-- Records a finished call by its HTTP status. A 5xx or no answer is a failure, and any other real
-- answer, 429 included, is a success because the backend is clearly up. A local refusal below zero
-- never reached the backend, so it changes nothing. A neutral 408 or 425 changes nothing either,
-- except that a half open breaker frees its probe slot so the next call can probe again.
function CircuitBreaker.RecordResult(self: CircuitBreaker, Now: number, Status: number)
	if Status ~= Status or Status < 0 then
		return
	end
	if CircuitBreaker.IsNeutral(Status) then
		if self.Current == "HalfOpen" then
			self.ProbeStartedAt = nil
		end
		return
	end
	if CircuitBreaker.CountsAsFailure(Status) then
		self:RecordFailure(Now)
	else
		self:RecordSuccess(Now)
	end
end

function CircuitBreaker.State(self: CircuitBreaker): State
	return self.Current
end

return CircuitBreaker
