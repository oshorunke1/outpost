--!strict
-- HttpCall holds the parts of RobloxTransport that need no Roblox, so Lune can test them.
-- Race runs one request and gives up waiting once a timer fires, because HttpService has no
-- timeout of its own and a stuck request would hold up the caller and the shared token trade.
-- The first of the answer, an error or the timer decides the outcome, and anything after that is
-- ignored, so a late answer can never wake the caller a second time.
-- ToOptions turns a backend request into HttpService options, and ToResponse turns whatever came
-- back into the Response BackendClient expects, with every header name in lowercase.
-- Nothing here touches game. The scheduler and the JSON functions are passed in.

export type Response = { Ok: boolean, Status: number, Body: any, Headers: { [string]: string } }
-- Copies of the types in BackendClient, because Shared modules require nothing. Change them together.
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
	-- Runs the callback once the seconds have passed. In game pass task.delay.
	Delay: (Seconds: number, Callback: () -> ()) -> (),
	-- Wakes a waiting thread with these values. In game pass task.spawn.
	Resume: (Thread: thread, ...any) -> (),
}

-- Done means the work answered, Failed means it threw, TimedOut means the timer won.
export type Outcome = "Done" | "Failed" | "TimedOut"

local HttpCall = {}

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
-- what Work returned, or for Failed, the error. It must be called from a thread that can yield.
function HttpCall.Race(Work: () -> any, Seconds: number, Scheduler: Scheduler): (Outcome, any)
	local Caller = coroutine.running()
	local Settled = false
	local Waiting = false
	local Result: Outcome = "TimedOut"
	local Value: any = nil

	local function Settle(Outcome: Outcome, Payload: any)
		if Settled then
			return
		end
		Settled = true
		if Waiting then
			Scheduler.Resume(Caller, Outcome, Payload)
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
	Scheduler.Delay(Seconds, function()
		Settle("TimedOut", nil)
	end)
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

return HttpCall
