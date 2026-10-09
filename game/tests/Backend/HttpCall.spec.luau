--!strict
local Serde = require("@lune/serde")
local Harness = require("@Tests/Harness")
local HttpCall = require("@Logic/Backend/HttpCall")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

type Timer = { Seconds: number, Callback: () -> () }
type Rig = {
	Scheduler: HttpCall.Scheduler,
	Timers: { Timer },
	Workers: { thread },
	Resumed: number,
}
type Got = { Outcome: string?, Value: any, Count: number }

-- A fake scheduler. Spawn runs the work in its own coroutine, Delay only remembers the timer, and
-- the spec decides when the answer arrives and when the timer fires.
local function NewRig(): Rig
	local Rig: Rig = { Timers = {}, Workers = {}, Resumed = 0, Scheduler = nil :: any }
	Rig.Scheduler = {
		Spawn = function(Callback: () -> ())
			local Thread = coroutine.create(Callback)
			table.insert(Rig.Workers, Thread)
			local Ok, Err = coroutine.resume(Thread)
			if not Ok then
				error(Err, 0)
			end
		end,
		Delay = function(Seconds: number, Callback: () -> ())
			table.insert(Rig.Timers, { Seconds = Seconds, Callback = Callback })
		end,
		Resume = function(Thread: thread, ...: any)
			Rig.Resumed += 1
			local Ok, Err = coroutine.resume(Thread, ...)
			if not Ok then
				error(Err, 0)
			end
		end,
	}
	return Rig
end

-- Runs Race in its own coroutine, the way a server thread would, and records what it hands back.
local function Start(Rig: Rig, Work: () -> any, Seconds: number): Got
	local Got: Got = { Outcome = nil, Value = nil, Count = 0 }
	local Thread = coroutine.create(function()
		local Outcome, Value = HttpCall.Race(Work, Seconds, Rig.Scheduler)
		Got.Outcome = Outcome
		Got.Value = Value
		Got.Count += 1
	end)
	local Ok, Err = coroutine.resume(Thread)
	if not Ok then
		error(Err, 0)
	end
	return Got
end

-- Work that waits until the spec hands it an answer.
local function Slow(): any
	return coroutine.yield()
end

local function Answer(Rig: Rig, Value: any)
	local Ok, Err = coroutine.resume(Rig.Workers[1], Value)
	if not Ok then
		error(Err, 0)
	end
end

local function Encode(Value: any): string
	return Serde.encode("json", Value)
end

local function Decode(Text: string): any
	return Serde.decode("json", Text)
end

Describe("HttpCall.Race", function()
	It("an answer that comes back at once wins and no timer is started", function()
		local Rig = NewRig()
		local Got = Start(Rig, function()
			return "fast"
		end, 15)
		Expect(Got.Outcome).ToBe("Done")
		Expect(Got.Value).ToBe("fast")
		Expect(#Rig.Timers).ToBe(0)
		Expect(Rig.Resumed).ToBe(0)
	end)

	It("waits on a timer of the given length while the request is out", function()
		local Rig = NewRig()
		local Got = Start(Rig, Slow, 7)
		Expect(Got.Count).ToBe(0)
		Expect(#Rig.Timers).ToBe(1)
		Expect(Rig.Timers[1].Seconds).ToBe(7)
	end)

	It("an answer before the timeout wins, and the timer firing later changes nothing", function()
		local Rig = NewRig()
		local Got = Start(Rig, Slow, 15)
		Answer(Rig, "answer")
		Expect(Got.Outcome).ToBe("Done")
		Expect(Got.Value).ToBe("answer")
		Rig.Timers[1].Callback()
		Expect(Got.Count).ToBe(1)
		Expect(Got.Outcome).ToBe("Done")
		Expect(Rig.Resumed).ToBe(1)
	end)

	It("the timeout fires first, and the late answer is ignored", function()
		local Rig = NewRig()
		local Got = Start(Rig, Slow, 15)
		Rig.Timers[1].Callback()
		Expect(Got.Outcome).ToBe("TimedOut")
		Expect(Got.Value).ToBeNil()
		Answer(Rig, "late")
		Expect(Got.Count).ToBe(1)
		Expect(Got.Outcome).ToBe("TimedOut")
		Expect(Got.Value).ToBeNil()
		Expect(Rig.Resumed).ToBe(1)
	end)

	It("work that throws at once is Failed with its error", function()
		local Rig = NewRig()
		local Got = Start(Rig, function(): any
			error("HttpService is not allowed to access that site", 0)
		end, 15)
		Expect(Got.Outcome).ToBe("Failed")
		Expect(Got.Value).ToBe("HttpService is not allowed to access that site")
		Expect(#Rig.Timers).ToBe(0)
	end)

	It("work that throws after waiting is Failed, and the timer firing later changes nothing", function()
		local Rig = NewRig()
		local Got = Start(Rig, function(): any
			coroutine.yield()
			error("Http requests can only be executed by game server", 0)
		end, 15)
		Answer(Rig, nil)
		Expect(Got.Outcome).ToBe("Failed")
		Rig.Timers[1].Callback()
		Expect(Got.Count).ToBe(1)
		Expect(Rig.Resumed).ToBe(1)
	end)
end)

Describe("HttpCall.ToOptions", function()
	It("copies the request and encodes a body", function()
		local Secret = newproxy(false)
		local Headers: { [string]: any } = { Authorization = Secret, ["Idempotency-Key"] = "job-1:1:1" }
		local Options = HttpCall.ToOptions(
			{ Method = "POST", Url = "https://x.test/v1/a", Headers = Headers, Body = { amount = 5 } },
			Encode
		)
		Expect(Options.Url).ToBe("https://x.test/v1/a")
		Expect(Options.Method).ToBe("POST")
		Expect(Options.Headers.Authorization).ToBe(Secret)
		Expect(Options.Headers["Idempotency-Key"]).ToBe("job-1:1:1")
		Expect(Decode(Options.Body :: string).amount).ToBe(5)
		Options.Headers.Extra = "x"
		Expect(Headers.Extra).ToBeNil()
	end)

	It("sends no body at all when the request has none", function()
		local Options = HttpCall.ToOptions({ Method = "GET", Url = "https://x.test/v1/flags", Headers = {} }, Encode)
		Expect(Options.Body).ToBeNil()
	end)
end)

Describe("HttpCall.ToResponse", function()
	It("keeps the status, decodes the JSON body and lowercases every header name", function()
		local Response = HttpCall.ToResponse({
			Success = false,
			StatusCode = 429,
			StatusMessage = "Too Many Requests",
			Headers = { ["Retry-After"] = "3", ["Idempotent-Replayed"] = "true" },
			Body = '{"error":"rate_limited"}',
		}, Decode)
		Expect(Response.Ok).ToBe(false)
		Expect(Response.Status).ToBe(429)
		Expect(Response.Body.error).ToBe("rate_limited")
		Expect(Response.Headers["retry-after"]).ToBe("3")
		Expect(Response.Headers["idempotent-replayed"]).ToBe("true")
		Expect(Response.Headers["Retry-After"]).ToBeNil()
	end)

	It("Ok follows Success", function()
		local Response = HttpCall.ToResponse({ Success = true, StatusCode = 201, Headers = {}, Body = "{}" }, Decode)
		Expect(Response.Ok).ToBe(true)
		Expect(Response.Status).ToBe(201)
		-- Ok never comes from the status, only from what Roblox says in Success.
		local Refused = HttpCall.ToResponse({ Success = false, StatusCode = 200, Headers = {} }, Decode)
		Expect(Refused.Ok).ToBe(false)
		Expect(Refused.Status).ToBe(200)
	end)

	It("an empty, missing or garbled body comes back as nil with the status kept", function()
		for _, Raw in { { Body = "" }, {}, { Body = "<html>bad gateway</html>" }, { Body = 5 } } :: { any } do
			Raw.Success = false
			Raw.StatusCode = 502
			local Response = HttpCall.ToResponse(Raw, Decode)
			Expect(Response.Status).ToBe(502)
			Expect(Response.Body).ToBeNil()
		end
	end)

	It("drops header entries that are not strings and survives missing headers", function()
		local Response =
			HttpCall.ToResponse({ Success = true, StatusCode = 204, Headers = { [1] = "x" } :: any }, Decode)
		Expect(next(Response.Headers)).ToBeNil()
		local Bare = HttpCall.ToResponse({ Success = true, StatusCode = 204 }, Decode)
		Expect(next(Bare.Headers)).ToBeNil()
	end)

	It("anything that is not a reply turns into Status 0", function()
		for _, Raw in { false, "oops", {}, { StatusCode = "200" }, { StatusCode = 0 / 0 } } :: { any } do
			local Response = HttpCall.ToResponse(Raw, Decode)
			Expect(Response.Ok).ToBe(false)
			Expect(Response.Status).ToBe(0)
			Expect(Response.Body).ToBeNil()
			Expect(next(Response.Headers)).ToBeNil()
		end
		Expect(HttpCall.ToResponse(nil, Decode).Status).ToBe(0)
	end)

	It("NoAnswer is a fresh Status 0 each time", function()
		local First = HttpCall.NoAnswer()
		Expect(First.Status).ToBe(0)
		Expect(First.Ok).ToBe(false)
		First.Headers.x = "y"
		Expect(HttpCall.NoAnswer().Headers.x).ToBeNil()
	end)
end)

return nil
