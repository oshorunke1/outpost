--!strict
-- The Lune twin of RobloxTransport. It sends one request with @lune/net and never throws, so the
-- contract runner drives the real backend through the very same BackendClient the game uses.
-- The hard parts live in Shared HttpCall.Send, the same code RobloxTransport runs. That means
-- every request races a real timer, a body is turned into JSON first, and header names come back
-- in lowercase. This file only swaps HttpService for @lune/net and task for @lune/task.
-- LuneTransport.Send is ready to use. LuneTransport.new lets a spec pass in a fake request.
local Net = require("@lune/net")
local Serde = require("@lune/serde")
local Task = require("@lune/task")
local BackendClient = require("@Logic/Backend/BackendClient")
local HttpCall = require("@Logic/Backend/HttpCall")

export type Deps = {
	-- Sends one request, net.request by default.
	Request: ((Params: any) -> any)?,
	-- How long one request may take, 15 seconds by default like Configs/Backend in game.
	ConfigSeconds: number?,
	-- Told why a call failed, print by default.
	Warn: ((Message: string) -> ())?,
}

local LuneTransport = {}

LuneTransport.DefaultSeconds = 15

-- The Lune scheduler, shaped the way HttpCall expects.
LuneTransport.Scheduler = {
	Spawn = function(Callback: () -> ())
		Task.spawn(Callback)
	end,
	Delay = function(Seconds: number, Callback: () -> ()): any
		return Task.delay(Seconds, Callback)
	end,
	Cancel = function(Handle: any)
		Task.cancel(Handle)
	end,
	Resume = function(Thread: thread, ...: any)
		Task.spawn(Thread, ...)
	end,
} :: HttpCall.Scheduler

-- Sends HttpService style options with a Lune style request function, and hands back what
-- HttpService RequestAsync would have, so HttpCall can read it the same way.
local function Adapt(Request: (Params: any) -> any): (Options: HttpCall.Options) -> any
	return function(Options: HttpCall.Options): any
		local Fetched = Request({
			url = Options.Url,
			method = Options.Method,
			headers = Options.Headers,
			body = Options.Body,
		})
		return {
			Success = Fetched.ok,
			StatusCode = Fetched.statusCode,
			Headers = Fetched.headers,
			Body = Fetched.body,
		}
	end
end

function LuneTransport.new(Deps: Deps?): BackendClient.Transport
	local Given: Deps = Deps or {}
	local SendDeps: HttpCall.SendDeps = {
		Request = Adapt(Given.Request or Net.request :: any),
		Encode = function(Value: any): string
			return Serde.encode("json", Value)
		end,
		Decode = function(Text: string): any
			return Serde.decode("json", Text)
		end,
		Scheduler = LuneTransport.Scheduler,
		ConfigSeconds = Given.ConfigSeconds or LuneTransport.DefaultSeconds,
		Warn = Given.Warn or function(Message: string)
			print(`[LuneTransport] {Message}`)
		end,
	}
	return function(Request: BackendClient.TransportRequest): BackendClient.Response
		return HttpCall.Send(Request, SendDeps)
	end
end

LuneTransport.Send = LuneTransport.new()

return LuneTransport
