--!strict
local Harness = require("@Tests/Harness")
local RetryPolicy = require("@Logic/Backend/RetryPolicy")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

-- selene: allow(divide_by_zero)
local NaN = 0 / 0
local Policy: RetryPolicy.Policy = { MaxAttempts = 3, BaseDelay = 0.5, MaxDelay = 4 }

Describe("RetryPolicy.IsRetryable", function()
	It("retries no answer, timeouts, throttles and server errors", function()
		for _, Status in { 0, 408, 425, 429, 500, 502, 503, 504 } do
			Expect(RetryPolicy.IsRetryable(Status)).ToBe(true)
		end
	end)

	It("never retries a success or a definite client error", function()
		for _, Status in { 200, 201, 202, 204, 400, 401, 403, 404, 409, 422 } do
			Expect(RetryPolicy.IsRetryable(Status)).ToBe(false)
		end
	end)

	It("never retries a refusal made on this server", function()
		Expect(RetryPolicy.IsRetryable(-1)).ToBe(false)
		Expect(RetryPolicy.IsRetryable(-2)).ToBe(false)
	end)
end)

Describe("RetryPolicy.ShouldRetry", function()
	It("stops at MaxAttempts", function()
		Expect(RetryPolicy.ShouldRetry(Policy, 1, 503)).ToBe(true)
		Expect(RetryPolicy.ShouldRetry(Policy, 2, 503)).ToBe(true)
		Expect(RetryPolicy.ShouldRetry(Policy, 3, 503)).ToBe(false)
		Expect(RetryPolicy.ShouldRetry(Policy, 1, 422)).ToBe(false)
	end)
end)

Describe("RetryPolicy.DelayFor", function()
	It("doubles the ceiling each attempt up to MaxDelay", function()
		Expect(RetryPolicy.DelayFor(Policy, 1, 1)).ToBe(0.5)
		Expect(RetryPolicy.DelayFor(Policy, 2, 1)).ToBe(1)
		Expect(RetryPolicy.DelayFor(Policy, 3, 1)).ToBe(2)
		Expect(RetryPolicy.DelayFor(Policy, 4, 1)).ToBe(4)
		Expect(RetryPolicy.DelayFor(Policy, 9, 1)).ToBe(4)
		Expect(RetryPolicy.DelayFor(Policy, 5000, 1)).ToBe(4)
	end)

	It("is full jitter, anywhere from zero up to the ceiling", function()
		Expect(RetryPolicy.DelayFor(Policy, 3, 0)).ToBe(0)
		Expect(RetryPolicy.DelayFor(Policy, 3, 0.25)).ToBe(0.5)
	end)

	It("clamps a broken random number instead of erroring", function()
		Expect(RetryPolicy.DelayFor(Policy, 2, NaN)).ToBe(0)
		Expect(RetryPolicy.DelayFor(Policy, 2, -3)).ToBe(0)
		Expect(RetryPolicy.DelayFor(Policy, 2, 7)).ToBe(1)
		Expect(RetryPolicy.DelayFor(Policy, 2, math.huge)).ToBe(1)
		Expect(RetryPolicy.DelayFor(Policy, 2, 1.5)).ToBe(1)
	end)

	It("treats a broken attempt number as the first attempt", function()
		Expect(RetryPolicy.DelayFor(Policy, NaN, 1)).ToBe(0.5)
		Expect(RetryPolicy.DelayFor(Policy, 0, 1)).ToBe(0.5)
		Expect(RetryPolicy.DelayFor(Policy, -4, 1)).ToBe(0.5)
	end)

	It("the default policy tries three times", function()
		Expect(RetryPolicy.Default.MaxAttempts).ToBe(3)
		Expect(RetryPolicy.Default.BaseDelay).ToBe(0.5)
		Expect(RetryPolicy.Default.MaxDelay).ToBe(4)
	end)
end)

Describe("RetryPolicy.DelayFor with a server Retry-After", function()
	It("waits as long as the server asked, plus its own jittered backoff, when that is longer", function()
		Expect(RetryPolicy.DelayFor(Policy, 1, 1, 7)).ToBe(7.5)
		Expect(RetryPolicy.DelayFor(Policy, 3, 0, 2.5)).ToBe(2.5)
		Expect(RetryPolicy.DelayFor(Policy, 3, 0.5, 2.5)).ToBe(3.5)
	end)

	-- Review M4. Many servers that got the same 429 at the same moment must not all come back at
	-- the same instant, so two different random numbers give two different waits.
	It("servers that got the same Retry-After spread out instead of retrying in lockstep", function()
		local First = RetryPolicy.DelayFor(Policy, 2, 0.1, 5)
		local Second = RetryPolicy.DelayFor(Policy, 2, 0.9, 5)
		Expect(First).ToBe(5.1)
		Expect(Second).ToBe(5.9)
	end)

	It("never waits less than its own backoff for that attempt", function()
		Expect(RetryPolicy.DelayFor(Policy, 3, 1, 0)).ToBe(2)
		Expect(RetryPolicy.DelayFor(Policy, 3, 1, 1)).ToBe(2)
		Expect(RetryPolicy.DelayFor(Policy, 3, 1, 2)).ToBe(2)
		Expect(RetryPolicy.DelayFor(Policy, 2, 0.5, 0.25)).ToBe(0.5)
	end)

	It("caps a long Retry-After at MaxRetryAfter before adding the backoff", function()
		Expect(RetryPolicy.MaxRetryAfter).ToBe(30)
		Expect(RetryPolicy.DelayFor(Policy, 1, 1, 30)).ToBe(30.5)
		Expect(RetryPolicy.DelayFor(Policy, 1, 1, 31)).ToBe(30.5)
		Expect(RetryPolicy.DelayFor(Policy, 1, 1, 86400)).ToBe(30.5)
		Expect(RetryPolicy.DelayFor(Policy, 1, 0, math.huge)).ToBe(30)
		Expect(RetryPolicy.DelayFor(Policy, 9, 1, math.huge)).ToBe(34)
	end)

	It("ignores a missing, negative or NaN Retry-After", function()
		Expect(RetryPolicy.DelayFor(Policy, 2, 1, nil)).ToBe(1)
		Expect(RetryPolicy.DelayFor(Policy, 2, 1, -5)).ToBe(1)
		Expect(RetryPolicy.DelayFor(Policy, 2, 1, NaN)).ToBe(1)
	end)
end)

Describe("RetryPolicy.ParseRetryAfter", function()
	It("reads whole seconds the way servers send them", function()
		Expect(RetryPolicy.ParseRetryAfter("0")).ToBe(0)
		Expect(RetryPolicy.ParseRetryAfter("7")).ToBe(7)
		Expect(RetryPolicy.ParseRetryAfter(" 12 ")).ToBe(12)
		Expect(RetryPolicy.ParseRetryAfter("120")).ToBe(120)
	end)

	It("returns nil for anything that is not plain whole seconds", function()
		Expect(RetryPolicy.ParseRetryAfter(nil)).ToBeNil()
		Expect(RetryPolicy.ParseRetryAfter("")).ToBeNil()
		Expect(RetryPolicy.ParseRetryAfter("-3")).ToBeNil()
		Expect(RetryPolicy.ParseRetryAfter("1.5")).ToBeNil()
		Expect(RetryPolicy.ParseRetryAfter("1e3")).ToBeNil()
		Expect(RetryPolicy.ParseRetryAfter("0x10")).ToBeNil()
		Expect(RetryPolicy.ParseRetryAfter("nan")).ToBeNil()
		Expect(RetryPolicy.ParseRetryAfter("inf")).ToBeNil()
		Expect(RetryPolicy.ParseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT")).ToBeNil()
		Expect(RetryPolicy.ParseRetryAfter("99999999999999999999")).ToBeNil()
	end)
end)

return nil
