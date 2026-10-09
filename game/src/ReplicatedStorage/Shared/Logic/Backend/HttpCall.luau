--!strict
-- HttpCall holds the parts of RobloxTransport that need no Roblox, so Lune can test them.
-- Race runs one request and gives up waiting once a timer fires, because HttpService has no
-- timeout of its own and a stuck request would hold up the caller and the shared token trade.
-- The first of the answer, an error or the timer decides the outcome, and anything after that is
-- ignored, so a late answer can never wake the caller a second time.
-- ToOptions turns a backend request into HttpService options, and ToResponse turns whatever came
-- back into the Response BackendClient expects, with every header name in lowercase.
-- Send puts them together. It encodes first, so a bad body is refused before anything is sent.
-- Nothing here touches game. The scheduler, HttpService and the JSON functions are passed in.

-- Copies of the types in BackendClient, because Shared modules require nothing. Change them together.
export type Response = { Ok: boolean, Status: number, Body: any, Headers: { [string]: string } }
export type TransportRequest = {
	Method: string,
	Url: string,
	Headers: { [string]: any },
	Body: any?,
	TimeoutSeconds: number?,
}
export type Options = { Url: string, Method: string, Headers: { [string]: any }, Body: string? }

export type Scheduler = {
	-- Runs the callback in a new thread right away. In game pass task.spawn.
	Spawn: (Callback: () -> ()) -> (),
	-- Runs the callback once the seconds have passed and hands back a handle. In game pass task.delay.
	Delay: (Seconds: number, Callback: () -> ()) -> any,
	-- Stops a timer that Delay started, given its handle. In game pass task.cancel.
	Cancel: ((Handle: any) -> ())?,
	-- Wakes a waiting thread with these values. In game pass task.spawn.
	Resume: (Thread: thread, ...any) -> (),
}

-- Done means the work answered, Failed means it threw, TimedOut means the timer won.
export type Outcome = "Done" | "Failed" | "TimedOut"

-- What Send needs. Request is HttpService RequestAsync in game. Warn is told why a call failed.
export type SendDeps = {
	Request: (Options: Options) -> any,
	Encode: (Value: any) -> string,
	Decode: (Text: string) -> any,
	Scheduler: Scheduler,
	ConfigSeconds: number,
	Warn: (Message: string) -> (),
}

local HttpCall = {}

-- Statuses below zero mean nothing was sent. They match BackendClient, and the spec checks that.
-- The call had no time left, so it can be tried again later. This is BackendClient.RetryLater.
HttpCall.OutOfTime = -3
-- The body could not be turned into JSON. Sending it again would fail the same way, so it is
-- never retried, and it says nothing about the backend, so it never counts against the breaker.
HttpCall.Unencodable = -4

-- What a transport hands back when nothing usable came back.
function HttpCall.NoAnswer(): Response
	return { Ok = false, Status = 0, Body = nil, Headers = {} }
end

-- How long to wait for one request. That is the configured time, or less when the call has less
-- time left before its deadline. A missing or broken Remaining means no deadline was given.
function HttpCall.TimeoutFor(ConfigSeconds: number, Remaining: number?): number
	if Remaining == nil or Remaining ~= Remaining then
		return ConfigSeconds
	end
	return math.min(ConfigSeconds, Remaining)
end

-- Runs Work and waits for it, but for no longer than Seconds. Hands back the outcome and, for Done,
-- what Work returned, or for Failed, the error. A caller that can't yield gets Failed at once.
function HttpCall.Race(Work: () -> any, Seconds: number, Scheduler: Scheduler): (Outcome, any)
	if not coroutine.isyieldable() then
		return "Failed", "this thread can't wait for a request"
	end
	local Caller = coroutine.running()
	local Settled = false
	local Waiting = false
	local Result: Outcome = "TimedOut"
	local Value: any = nil
	local Timer: any = nil

	local function Settle(Outcome: Outcome, Payload: any)
		if Settled then
			return
		end
		Settled = true
		-- The answer or the error won, so the timer has nothing left to do.
		local Cancel = Scheduler.Cancel
		if Outcome ~= "TimedOut" and Timer ~= nil and Cancel ~= nil then
			Cancel(Timer)
		end
		if Waiting then
			-- A caller that was cancelled while it waited is dead, and waking it would throw.
			if coroutine.status(Caller) == "suspended" then
				Scheduler.Resume(Caller, Outcome, Payload)
			end
		else
			Result = Outcome
			Value = Payload
		end
	end

	Scheduler.Spawn(function()
		local Worked, Payload = pcall(Work)
		Settle(if Worked then "Done" else "Failed", Payload)
	end)
	-- The work may have finished without ever waiting, and then there is nothing to time.
	if Settled then
		return Result, Value
	end
	Timer = Scheduler.Delay(Seconds, function()
		Settle("TimedOut", nil)
	end)
	-- A scheduler whose timer fires straight away has already settled, so there is nothing to wait for.
	if Settled then
		return Result, Value
	end
	Waiting = true
	return coroutine.yield()
end

function HttpCall.ToOptions(Request: TransportRequest, Encode: (Value: any) -> string): Options
	local Options: Options = {
		Url = Request.Url,
		Method = Request.Method,
		Headers = table.clone(Request.Headers),
		Body = nil,
	}
	if Request.Body ~= nil then
		Options.Body = Encode(Request.Body)
	end
	return Options
end

-- Raw is what HttpService RequestAsync returned. A body that is empty or not JSON comes back as nil.
function HttpCall.ToResponse(Raw: any, Decode: (Text: string) -> any): Response
	if type(Raw) ~= "table" or type(Raw.StatusCode) ~= "number" or Raw.StatusCode ~= Raw.StatusCode then
		return HttpCall.NoAnswer()
	end
	local Headers: { [string]: string } = {}
	if type(Raw.Headers) == "table" then
		for Name, Value in Raw.Headers do
			if type(Name) == "string" and type(Value) == "string" then
				Headers[string.lower(Name)] = Value
			end
		end
	end
	local Body: any = nil
	if type(Raw.Body) == "string" and Raw.Body ~= "" then
		local Decoded, Parsed = pcall(Decode, Raw.Body)
		if Decoded then
			Body = Parsed
		end
	end
	return { Ok = Raw.Success == true, Status = Raw.StatusCode, Body = Body, Headers = Headers }
end

local function Refusal(Status: number): Response
	return { Ok = false, Status = Status, Body = nil, Headers = {} }
end

-- One whole request. It never throws. The body is encoded before anything is timed or sent, the
-- wait is TimeoutFor the configured time and the time left, and any failure is a plain Response.
function HttpCall.Send(Request: TransportRequest, Deps: SendDeps): Response
	local Seconds = HttpCall.TimeoutFor(Deps.ConfigSeconds, Request.TimeoutSeconds)
	if Seconds <= 0 then
		return Refusal(HttpCall.OutOfTime)
	end
	local Encoded, Options = pcall(HttpCall.ToOptions, Request, Deps.Encode)
	if not Encoded then
		Deps.Warn(`could not encode the body of {Request.Method} {Request.Url}, {Options}`)
		return Refusal(HttpCall.Unencodable)
	end
	local Ran, Outcome, Raw = pcall(HttpCall.Race, function()
		return Deps.Request(Options)
	end, Seconds, Deps.Scheduler)
	if not Ran or Outcome == "Failed" then
		Deps.Warn(`{Request.Method} {Request.Url} failed, {if Ran then Raw else Outcome}`)
		return HttpCall.NoAnswer()
	elseif Outcome == "TimedOut" then
		Deps.Warn(`{Request.Method} {Request.Url} took over {Seconds} seconds`)
		return HttpCall.NoAnswer()
	end
	return HttpCall.ToResponse(Raw, Deps.Decode)
end

return HttpCall
