--!strict
local Serde = require("@lune/serde")
local Harness = require("@Tests/Harness")
local BackendClient = require("@Logic/Backend/BackendClient")
local HttpCall = require("@Logic/Backend/HttpCall")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

type Timer = { Seconds: number, Callback: () -> (), Id: number }
type Rig = {
	Scheduler: HttpCall.Scheduler,
	Timers: { Timer },
	Workers: { thread },
	Cancelled: { number },
	Resumed: number,
}
type Got = { Outcome: string?, Value: any, Count: number, Thread: thread? }

-- A fake scheduler. Spawn runs the work in its own coroutine, Delay only remembers the timer, and
-- the spec decides when the answer arrives and when the timer fires.
local function NewRig(): Rig
	local Rig: Rig = { Timers = {}, Workers = {}, Cancelled = {}, Resumed = 0, Scheduler = nil :: any }
	Rig.Scheduler = {
		Spawn = function(Callback: () -> ())
			local Thread = coroutine.create(Callback)
			table.insert(Rig.Workers, Thread)
			local Ok, Err = coroutine.resume(Thread)
			if not Ok then
				error(Err, 0)
			end
		end,
		Delay = function(Seconds: number, Callback: () -> ()): any
			local Id = #Rig.Timers + 1
			table.insert(Rig.Timers, { Seconds = Seconds, Callback = Callback, Id = Id })
			return Id
		end,
		Cancel = function(Handle: any)
			table.insert(Rig.Cancelled, Handle)
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
	local Got: Got = { Outcome = nil, Value = nil, Count = 0, Thread = nil }
	local Thread = coroutine.create(function()
		local Outcome, Value = HttpCall.Race(Work, Seconds, Rig.Scheduler)
		Got.Outcome = Outcome
		Got.Value = Value
		Got.Count += 1
	end)
	Got.Thread = Thread
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

Describe("HttpCall.Race edges", function()
	It("an answer that wins cancels the timer, and a timeout cancels nothing", function()
		local Rig = NewRig()
		Start(Rig, Slow, 7)
		Answer(Rig, "answer")
		Expect(Rig.Cancelled).ToEqual({ 1 })
		local Late = NewRig()
		Start(Late, Slow, 7)
		Late.Timers[1].Callback()
		Expect(#Late.Cancelled).ToBe(0)
	end)

	It("an error that wins cancels the timer too", function()
		local Rig = NewRig()
		Start(Rig, function(): any
			coroutine.yield()
			error("boom", 0)
		end, 7)
		Answer(Rig, nil)
		Expect(Rig.Cancelled).ToEqual({ 1 })
	end)

	It("a timer that fires straight away still hands back TimedOut instead of stranding the caller", function()
		local Rig = NewRig()
		Rig.Scheduler.Delay = function(_Seconds: number, Callback: () -> ()): any
			Callback()
			return nil
		end
		local Got = Start(Rig, Slow, 7)
		Expect(Got.Count).ToBe(1)
		Expect(Got.Outcome).ToBe("TimedOut")
		Expect(Rig.Resumed).ToBe(0)
	end)

	It("a caller that was cancelled while waiting is never woken", function()
		local Rig = NewRig()
		local Got = Start(Rig, Slow, 7)
		coroutine.close(Got.Thread :: thread)
		Answer(Rig, "late")
		Expect(Rig.Resumed).ToBe(0)
		Expect(Got.Count).ToBe(0)
	end)

	It("a caller that can't wait gets Failed and nothing is started", function()
		local Rig = NewRig()
		local Outcome: string? = nil
		-- A sort comparator runs inside a C call, which is a place where a thread can't yield.
		table.sort({ 2, 1 }, function(Left: number, Right: number): boolean
			if Outcome == nil then
				Outcome = HttpCall.Race(Slow, 7, Rig.Scheduler)
			end
			return Left < Right
		end)
		Expect(Outcome).ToBe("Failed")
		Expect(#Rig.Workers).ToBe(0)
		Expect(#Rig.Timers).ToBe(0)
	end)
end)

-- Runs HttpCall.Send in its own coroutine and records the response.
type SendRig = { Rig: Rig, Sent: { any }, Warned: { string }, Answer: { Response: any? }, Thread: thread? }

local function StartSend(
	Request: HttpCall.TransportRequest,
	Reply: (Options: HttpCall.Options) -> any,
	EncodeWith: ((Value: any) -> string)?
): (SendRig, () -> HttpCall.Response?)
	local Rig = NewRig()
	local Box: { Response: HttpCall.Response? } = { Response = nil }
	local Setup: SendRig = { Rig = Rig, Sent = {}, Warned = {}, Answer = Box, Thread = nil }
	local Deps: HttpCall.SendDeps = {
		Request = function(Options: HttpCall.Options): any
			table.insert(Setup.Sent, Options)
			return Reply(Options)
		end,
		Encode = EncodeWith or Encode,
		Decode = Decode,
		Scheduler = Rig.Scheduler,
		ConfigSeconds = 15,
		Warn = function(Message: string)
			table.insert(Setup.Warned, Message)
		end,
	}
	local Thread = coroutine.create(function()
		Box.Response = HttpCall.Send(Request, Deps)
	end)
	Setup.Thread = Thread
	local Ok, Err = coroutine.resume(Thread)
	if not Ok then
		error(Err, 0)
	end
	return Setup, function()
		return Box.Response
	end
end

local function Get(Seconds: number?, Body: any?): HttpCall.TransportRequest
	return {
		Method = if Body ~= nil then "POST" else "GET",
		Url = "https://x.test/v1/flags",
		Headers = {},
		Body = Body,
		TimeoutSeconds = Seconds,
	}
end

Describe("HttpCall.Send", function()
	It("uses the same status numbers as BackendClient", function()
		Expect(HttpCall.OutOfTime).ToBe(BackendClient.RetryLater)
		Expect(HttpCall.Unencodable).ToBe(BackendClient.Unencodable)
	end)

	It("a body that will not encode is refused before anything is sent or timed", function()
		-- Roblox JSONEncode throws on things like a table that holds itself, so this Encode throws too.
		local function Refuse(_Value: any): string
			error("Cannot convert to JSON", 0)
		end
		for _, Body in { { amount = 5 }, { 1, 2 } } :: { any } do
			local Setup, Result = StartSend(Get(10, Body), function(): any
				error("must not send")
			end, Refuse)
			local Response = Result() :: HttpCall.Response
			Expect(Response.Status).ToBe(HttpCall.Unencodable)
			Expect(Response.Ok).ToBe(false)
			Expect(#Setup.Sent).ToBe(0)
			Expect(#Setup.Rig.Timers).ToBe(0)
			Expect(#Setup.Warned).ToBe(1)
		end
	end)

	It("a call with no time left is refused before anything is sent", function()
		for _, Seconds in { 0, -1 } do
			local Setup, Result = StartSend(Get(Seconds), function(): any
				error("must not send")
			end)
			Expect((Result() :: HttpCall.Response).Status).ToBe(HttpCall.OutOfTime)
			Expect(#Setup.Sent).ToBe(0)
		end
	end)

	It("waits the smaller of the configured time and the time the call has left", function()
		local Setup = StartSend(Get(6), function(): any
			return coroutine.yield()
		end)
		Expect(Setup.Rig.Timers[1].Seconds).ToBe(6)
		local Long = StartSend(Get(120), function(): any
			return coroutine.yield()
		end)
		Expect(Long.Rig.Timers[1].Seconds).ToBe(15)
		local Unset = StartSend(Get(nil), function(): any
			return coroutine.yield()
		end)
		Expect(Unset.Rig.Timers[1].Seconds).ToBe(15)
	end)

	It("an answer comes back as a Response with lowercase headers and an encoded body went out", function()
		local Setup, Result = StartSend(Get(10, { amount = 5 }), function(): any
			return { Success = true, StatusCode = 201, Headers = { ["Idempotent-Replayed"] = "true" }, Body = '{"a":1}' }
		end)
		local Response = Result() :: HttpCall.Response
		Expect(Response.Ok).ToBe(true)
		Expect(Response.Status).ToBe(201)
		Expect(Response.Body.a).ToBe(1)
		Expect(Response.Headers["idempotent-replayed"]).ToBe("true")
		Expect(Decode(Setup.Sent[1].Body).amount).ToBe(5)
	end)

	It("a request that throws or times out is Status 0 with a warning", function()
		local Setup, Result = StartSend(Get(10), function(): any
			error("Http requests are not enabled", 0)
		end)
		Expect((Result() :: HttpCall.Response).Status).ToBe(0)
		Expect(#Setup.Warned).ToBe(1)
		local Hung, HungResult = StartSend(Get(10), function(): any
			return coroutine.yield()
		end)
		Expect(HungResult()).ToBeNil()
		Hung.Rig.Timers[1].Callback()
		Expect((HungResult() :: HttpCall.Response).Status).ToBe(0)
		Expect(#Hung.Warned).ToBe(1)
	end)
end)

Describe("HttpCall.TimeoutFor", function()
	It("waits the configured time when the call has longer than that left", function()
		Expect(HttpCall.TimeoutFor(15, 120)).ToBe(15)
	end)

	It("waits only as long as the call has left when that is shorter", function()
		Expect(HttpCall.TimeoutFor(15, 6.5)).ToBe(6.5)
		Expect(HttpCall.TimeoutFor(15, 0)).ToBe(0)
		Expect(HttpCall.TimeoutFor(15, -2)).ToBe(-2)
	end)

	It("uses the configured time when the caller gave no deadline or a broken one", function()
		Expect(HttpCall.TimeoutFor(15, nil)).ToBe(15)
		Expect(HttpCall.TimeoutFor(15, 0 / 0)).ToBe(15)
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
