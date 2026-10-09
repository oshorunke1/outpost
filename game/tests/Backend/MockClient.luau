--!strict
-- A real BackendClient on MockTransport with a fake clock, for the flag and telemetry specs.
-- Sends records every request that went on the wire, and Intercept can answer one instead.
local BackendClient = require("@Logic/Backend/BackendClient")
local CircuitBreaker = require("@Logic/Backend/CircuitBreaker")
local MockTransport = require("@Logic/Backend/MockTransport")
local RetryPolicy = require("@Logic/Backend/RetryPolicy")
local RateLimiter = require("@Logic/Net/RateLimiter")
local Flags = require("@Configs/Flags")
local Shop = require("@Configs/Shop")
local Telemetry = require("@Configs/Telemetry")

local MockClient = {}

-- The mock's idea of now in Unix milliseconds, late 2023.
MockClient.NowMillis = 1700000000000

function MockClient.new(Intercept: ((Request: any) -> any?)?)
	local Clock = { Now = 0 }
	local Transport, Controls = MockTransport.new(Shop, Flags :: any, Telemetry, function()
		return MockClient.NowMillis
	end)
	local Rig: any = { Clock = Clock, Controls = Controls, Sends = {} }
	local Client = BackendClient.new({
		BaseUrl = "http://mock",
		Transport = function(Request: any): any
			table.insert(Rig.Sends, Request)
			local Faked = if Intercept then Intercept(Request) else nil
			if Faked ~= nil then
				return Faked
			end
			return Transport(Request)
		end,
		ApiKeyHeader = "ApiKey mock",
		Now = function()
			return Clock.Now
		end,
		Sleep = function(Seconds: number)
			Clock.Now += Seconds
		end,
		RandomUnit = function()
			return 0
		end,
		Retry = RetryPolicy,
		Policy = RetryPolicy.Default,
		Breakers = {
			Auth = CircuitBreaker.new(5, 30),
			Economy = CircuitBreaker.new(5, 30),
			Telemetry = CircuitBreaker.new(5, 30),
			Flags = CircuitBreaker.new(5, 30),
		},
		Budget = RateLimiter.new(10000, 10000),
	})
	Rig.Client = Client

	-- Every request whose URL ends with Suffix, in order.
	function Rig.Sent(Suffix: string): { any }
		local Found = {}
		for _, Request in Rig.Sends do
			if string.sub(Request.Url, -#Suffix) == Suffix then
				table.insert(Found, Request)
			end
		end
		return Found
	end

	return Rig
end

return MockClient
