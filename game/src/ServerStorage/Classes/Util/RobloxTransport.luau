--!strict
-- RobloxTransport sends one backend request with HttpService.
-- Every request races a timer, so a request that hangs gives up after RequestTimeoutSeconds, or
-- sooner when the call has less time left before its deadline.
-- The body is turned into JSON first. A body that can't be is refused with Unencodable, which is
-- never retried and never counts against the breaker.
-- Any other failure, a thrown error, a timeout or a reply that is not JSON, turns into a plain
-- result, so BackendClient never has to catch anything. Header names come back in lowercase.
-- All of that lives in Shared HttpCall.Send, which has its own Lune spec. This file only wires it.
local HttpService = game:GetService("HttpService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerStorage = game:GetService("ServerStorage")

local BackendClient = require(ReplicatedStorage.Shared.Logic.Backend.BackendClient)
local HttpCall = require(ReplicatedStorage.Shared.Logic.Backend.HttpCall)
local BackendConfig = require(ServerStorage.Configs.Backend)

-- A failing backend can fail every call, so the warning shows at most once in this many seconds.
local WarnEverySeconds = 30

local LastWarnAt = -math.huge

local function WarnSometimes(Message: string)
	local Now = os.clock()
	if Now - LastWarnAt >= WarnEverySeconds then
		LastWarnAt = Now
		warn(`[RobloxTransport] {Message}`)
	end
end

local Deps: HttpCall.SendDeps = {
	Request = function(Options: HttpCall.Options): any
		return HttpService:RequestAsync(Options :: any)
	end,
	Encode = function(Value: any): string
		return HttpService:JSONEncode(Value)
	end,
	Decode = function(Text: string): any
		return HttpService:JSONDecode(Text)
	end,
	Scheduler = {
		Spawn = function(Callback: () -> ())
			task.spawn(Callback)
		end,
		Delay = function(Seconds: number, Callback: () -> ()): any
			return task.delay(Seconds, Callback)
		end,
		Cancel = function(Handle: any)
			task.cancel(Handle)
		end,
		Resume = function(Thread: thread, ...: any)
			task.spawn(Thread, ...)
		end,
	},
	ConfigSeconds = BackendConfig.RequestTimeoutSeconds,
	Warn = WarnSometimes,
}

local RobloxTransport = {}

-- The Scheduler RobloxTransport races with, so the Studio checklist can try the real timer.
RobloxTransport.Scheduler = Deps.Scheduler

function RobloxTransport.Send(Request: BackendClient.TransportRequest): BackendClient.Response
	return HttpCall.Send(Request, Deps)
end

return RobloxTransport
