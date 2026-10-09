--!strict
local Harness = require("@Tests/Harness")
local CircuitBreaker = require("@Logic/Backend/CircuitBreaker")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

-- selene: allow(divide_by_zero)
local NaN = 0 / 0

local function Opened(): CircuitBreaker.CircuitBreaker
	local Breaker = CircuitBreaker.new(3, 30)
	Breaker:RecordFailure(0)
	Breaker:RecordFailure(0)
	Breaker:RecordFailure(0)
	return Breaker
end

Describe("CircuitBreaker", function()
	It("starts closed and lets calls through", function()
		local Breaker = CircuitBreaker.new(3, 30)
		Expect(Breaker:State()).ToBe("Closed")
		Expect(Breaker:Allow(0)).ToBe(true)
	end)

	It("opens after FailureThreshold failures in a row and refuses", function()
		local Breaker = CircuitBreaker.new(3, 30)
		Breaker:RecordFailure(0)
		Breaker:RecordFailure(0)
		Expect(Breaker:State()).ToBe("Closed")
		Breaker:RecordFailure(0)
		Expect(Breaker:State()).ToBe("Open")
		Expect(Breaker:Allow(29)).ToBe(false)
	end)

	It("a success resets the failure count", function()
		local Breaker = CircuitBreaker.new(3, 30)
		Breaker:RecordFailure(0)
		Breaker:RecordFailure(0)
		Breaker:RecordSuccess(0)
		Breaker:RecordFailure(0)
		Breaker:RecordFailure(0)
		Expect(Breaker:State()).ToBe("Closed")
	end)

	It("after OpenSeconds it lets exactly one probe through", function()
		local Breaker = Opened()
		Expect(Breaker:Allow(30)).ToBe(true)
		Expect(Breaker:State()).ToBe("HalfOpen")
		Expect(Breaker:Allow(30.5)).ToBe(false)
	end)

	It("a probe that works closes it", function()
		local Breaker = Opened()
		Breaker:Allow(30)
		Breaker:RecordSuccess(31)
		Expect(Breaker:State()).ToBe("Closed")
		Expect(Breaker:Allow(31)).ToBe(true)
	end)

	It("a probe that fails opens it again with a fresh timer", function()
		local Breaker = Opened()
		Breaker:Allow(30)
		Breaker:RecordFailure(31)
		Expect(Breaker:State()).ToBe("Open")
		Expect(Breaker:Allow(60)).ToBe(false)
		Expect(Breaker:Allow(61)).ToBe(true)
	end)

	-- Review Focus 5. A probe whose caller never reports back cannot hold the breaker forever.
	It("a stuck probe is released after another OpenSeconds", function()
		local Breaker = Opened()
		Expect(Breaker:Allow(30)).ToBe(true)
		Expect(Breaker:Allow(45)).ToBe(false)
		Expect(Breaker:Allow(60)).ToBe(true)
	end)

	It("a NaN clock never lets a call through an open breaker", function()
		local Breaker = Opened()
		Expect(Breaker:Allow(NaN)).ToBe(false)
		Expect(Breaker:State()).ToBe("Open")
	end)

	It("an infinite clock never lets a call through an open or half open breaker", function()
		local Breaker = Opened()
		Expect(Breaker:Allow(math.huge)).ToBe(false)
		Expect(Breaker:Allow(-math.huge)).ToBe(false)
		Expect(Breaker:State()).ToBe("Open")
		Expect(Breaker:Allow(30)).ToBe(true)
		Expect(Breaker:Allow(math.huge)).ToBe(false)
		Expect(Breaker:State()).ToBe("HalfOpen")
	end)

	It("RecordFailure ignores a non-finite clock instead of corrupting state", function()
		local Breaker = CircuitBreaker.new(3, 30)
		Breaker:RecordFailure(NaN)
		Breaker:RecordFailure(math.huge)
		Breaker:RecordFailure(-math.huge)
		Breaker:RecordFailure(NaN)
		Expect(Breaker:State()).ToBe("Closed")
		Expect(Breaker:Allow(0)).ToBe(true)

		-- A half open probe failure with a broken clock leaves the probe in place, and a sane clock later still works.
		local Probing = Opened()
		Probing:Allow(30)
		Probing:RecordFailure(NaN)
		Expect(Probing:State()).ToBe("HalfOpen")
		Probing:RecordFailure(31)
		Expect(Probing:State()).ToBe("Open")
		Expect(Probing:Allow(60)).ToBe(false)
		Expect(Probing:Allow(61)).ToBe(true)
	end)

	It("refuses bad settings", function()
		Expect(function()
			CircuitBreaker.new(0, 30)
		end).ToThrow("FailureThreshold")
		Expect(function()
			CircuitBreaker.new(2.5, 30)
		end).ToThrow("FailureThreshold")
		Expect(function()
			CircuitBreaker.new(math.huge, 30)
		end).ToThrow("FailureThreshold")
		Expect(function()
			CircuitBreaker.new(3, math.huge)
		end).ToThrow("OpenSeconds")
		Expect(function()
			CircuitBreaker.new(3, NaN)
		end).ToThrow("OpenSeconds")
		Expect(function()
			CircuitBreaker.new(3, 0)
		end).ToThrow("OpenSeconds")
	end)
end)

Describe("CircuitBreaker.CountsAsFailure", function()
	It("counts no answer and server errors as an outage", function()
		for _, Status in { 0, 500, 502, 503, 504, 599 } do
			Expect(CircuitBreaker.CountsAsFailure(Status)).ToBe(true)
		end
	end)

	It("a 429 is back pressure from a live backend, not an outage", function()
		Expect(CircuitBreaker.CountsAsFailure(429)).ToBe(false)
	end)

	It("successes, client errors and local refusals are not outages", function()
		for _, Status in { 200, 204, 400, 401, 404, 408, 409, 422, 425, -1, -2 } do
			Expect(CircuitBreaker.CountsAsFailure(Status)).ToBe(false)
		end
	end)
end)

Describe("CircuitBreaker:RecordResult", function()
	It("a run of 429s never opens the breaker", function()
		local Breaker = CircuitBreaker.new(3, 30)
		for _ = 1, 10 do
			Breaker:RecordResult(0, 429)
		end
		Expect(Breaker:State()).ToBe("Closed")
		Expect(Breaker:Allow(0)).ToBe(true)
	end)

	It("a 429 between failures resets the run, since the backend answered", function()
		local Breaker = CircuitBreaker.new(3, 30)
		Breaker:RecordResult(0, 503)
		Breaker:RecordResult(0, 0)
		Breaker:RecordResult(0, 429)
		Breaker:RecordResult(0, 503)
		Breaker:RecordResult(0, 500)
		Expect(Breaker:State()).ToBe("Closed")
		Breaker:RecordResult(0, 502)
		Expect(Breaker:State()).ToBe("Open")
	end)

	It("a half open probe that gets a 429 closes the breaker", function()
		local Breaker = Opened()
		Breaker:Allow(30)
		Breaker:RecordResult(31, 429)
		Expect(Breaker:State()).ToBe("Closed")
	end)

	It("a half open probe that gets a 5xx or no answer opens it again", function()
		local Breaker = Opened()
		Breaker:Allow(30)
		Breaker:RecordResult(31, 0)
		Expect(Breaker:State()).ToBe("Open")
		Expect(Breaker:Allow(60)).ToBe(false)
	end)

	It("a local refusal changes nothing", function()
		local Breaker = CircuitBreaker.new(1, 30)
		Breaker:RecordResult(0, -1)
		Expect(Breaker:State()).ToBe("Closed")
		local Probing = Opened()
		Probing:Allow(30)
		Probing:RecordResult(31, -2)
		Expect(Probing:State()).ToBe("HalfOpen")
	end)

	-- Review M2. A NaN status is not a real answer, so it must not close a half open breaker.
	It("a NaN status changes nothing, even mid probe", function()
		local Probing = Opened()
		Probing:Allow(30)
		Probing:RecordResult(31, NaN)
		Expect(Probing:State()).ToBe("HalfOpen")
		local Fresh = CircuitBreaker.new(1, 30)
		Fresh:RecordResult(0, NaN)
		Expect(Fresh:State()).ToBe("Closed")
	end)

	It("a 408 or 425 neither resets a run of failures nor adds to it", function()
		for _, Status in { 408, 425 } do
			local Breaker = CircuitBreaker.new(3, 30)
			Breaker:RecordResult(0, 503)
			Breaker:RecordResult(0, 503)
			Breaker:RecordResult(0, Status)
			Breaker:RecordResult(0, Status)
			Expect(Breaker:State()).ToBe("Closed")
			Breaker:RecordResult(0, 503)
			Expect(Breaker:State()).ToBe("Open")
		end
	end)

	-- Task 25 fix M8. A 408 or 425 may come from an older call that was in flight before the probe,
	-- so it must not free the probe slot. Only a success, a failure or the probe timeout do that.
	It("a 408 or 425 in half open keeps the probe slot taken until the probe times out", function()
		for _, Status in { 408, 425 } do
			local Breaker = Opened()
			Expect(Breaker:Allow(30)).ToBe(true)
			Breaker:RecordResult(31, Status)
			Expect(Breaker:State()).ToBe("HalfOpen")
			Expect(Breaker:Allow(32)).ToBe(false)
			Expect(Breaker:Allow(59)).ToBe(false)
			Expect(Breaker:Allow(60)).ToBe(true)
		end
	end)

	It("a 408 or 425 while open changes nothing", function()
		local Breaker = Opened()
		Breaker:RecordResult(10, 408)
		Expect(Breaker:State()).ToBe("Open")
		Expect(Breaker:Allow(29)).ToBe(false)
	end)
end)

Describe("CircuitBreaker.IsNeutral", function()
	It("only a request timeout and too early are neutral", function()
		Expect(CircuitBreaker.IsNeutral(408)).ToBe(true)
		Expect(CircuitBreaker.IsNeutral(425)).ToBe(true)
		for _, Status in { 0, 200, 204, 400, 401, 404, 409, 422, 429, 500, 503, -1, -2 } do
			Expect(CircuitBreaker.IsNeutral(Status)).ToBe(false)
		end
	end)
end)

Describe("CircuitBreaker late answers", function()
	-- Review M1. Calls that were already in flight when the breaker opened can fail afterwards.
	-- They must not push the cooldown further out.
	It("a late failure while open leaves the cooldown alone", function()
		local Breaker = Opened()
		Breaker:RecordFailure(20)
		Breaker:RecordResult(25, 503)
		Expect(Breaker:Allow(30)).ToBe(true)
		Expect(Breaker:State()).ToBe("HalfOpen")
	end)

	-- Review M2. Picked on purpose. A real answer proves the backend is up, so it closes at once.
	It("a late success while open closes it, since the backend clearly answered", function()
		local Breaker = Opened()
		Breaker:RecordSuccess(10)
		Expect(Breaker:State()).ToBe("Closed")
		Expect(Breaker:Allow(10)).ToBe(true)
	end)
end)

return nil
