--!strict
-- RobloxTransport sends one backend request with HttpService.
-- Every request races a timer, so a request that hangs gives up after RequestTimeoutSeconds, or
-- sooner when the call has less time left before its deadline.
-- Any failure, a thrown error, a timeout or a reply that is not JSON, turns into a plain result,
-- so BackendClient never has to catch anything. Header names come back in lowercase.
-- The racing and the reply handling live in Shared HttpCall, which has its own Lune spec.
local HttpService = game:GetService("HttpService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerStorage = game:GetService("ServerStorage")

local BackendClient = require(ReplicatedStorage.Shared.Logic.Backend.BackendClient)
local HttpCall = require(ReplicatedStorage.Shared.Logic.Backend.HttpCall)
local BackendConfig = require(ServerStorage.Configs.Backend)

-- A failing backend can fail every call, so the warning shows at most once in this many seconds.
local WarnEverySeconds = 30

local Scheduler: HttpCall.Scheduler = {
	Spawn = function(Callback: () -> ())
		task.spawn(Callback)
	end,
	Delay = function(Seconds: number, Callback: () -> ())
		task.delay(Seconds, Callback)
	end,
	Resume = function(Thread: thread, ...: any)
		task.spawn(Thread, ...)
	end,
}

local LastWarnAt = -math.huge

local function Encode(Value: any): string
	return HttpService:JSONEncode(Value)
end

local function Decode(Text: string): any
	return HttpService:JSONDecode(Text)
end

local function WarnSometimes(Message: string)
	local Now = os.clock()
	if Now - LastWarnAt >= WarnEverySeconds then
		LastWarnAt = Now
		warn(`[RobloxTransport] {Message}`)
	end
end

local RobloxTransport = {}

function RobloxTransport.Send(Request: BackendClient.TransportRequest): BackendClient.Response
	local Seconds = HttpCall.TimeoutFor(BackendConfig.RequestTimeoutSeconds, Request.TimeoutSeconds)
	if Seconds <= 0 then
		-- The call is already out of time, so nothing is sent and it can be tried again later.
		return { Ok = false, Status = BackendClient.RetryLater, Body = nil, Headers = {} }
	end
	local Ran, Outcome, Raw = pcall(HttpCall.Race, function()
		return HttpService:RequestAsync(HttpCall.ToOptions(Request, Encode) :: any)
	end, Seconds, Scheduler)
	if not Ran then
		WarnSometimes(`could not send {Request.Method} {Request.Url}, {Outcome}`)
		return HttpCall.NoAnswer()
	end
	if Outcome == "TimedOut" then
		WarnSometimes(`{Request.Method} {Request.Url} took over {Seconds} seconds`)
		return HttpCall.NoAnswer()
	elseif Outcome == "Failed" then
		WarnSometimes(`{Request.Method} {Request.Url} failed, {Raw}`)
		return HttpCall.NoAnswer()
	end
	return HttpCall.ToResponse(Raw, Decode)
end

return RobloxTransport
