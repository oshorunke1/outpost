--!strict
-- Runs the backend contract suite against MockTransport, so the Studio mock is held to the same
-- contract as the real backend on every unit run.
local BackendClient = require("@Logic/Backend/BackendClient")
local CircuitBreaker = require("@Logic/Backend/CircuitBreaker")
local MockTransport = require("@Logic/Backend/MockTransport")
local RetryPolicy = require("@Logic/Backend/RetryPolicy")
local RateLimiter = require("@Logic/Net/RateLimiter")
local Flags = require("@Configs/Flags")
local Shop = require("@Configs/Shop")
local Telemetry = require("@Configs/Telemetry")
local Suite = require("@Tests/Contract/Suite")

-- The suite stamps events with the real wall clock, so the mock reads the same one.
local Transport = MockTransport.new(Shop, Flags, Telemetry, function()
	return os.time() * 1000
end)

local Clock = 0
local Client = BackendClient.new({
	BaseUrl = "http://mock",
	Transport = Transport,
	ApiKeyHeader = "ApiKey mock",
	Now = function()
		return Clock
	end,
	Sleep = function(Seconds: number)
		Clock += Seconds
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
	Budget = RateLimiter.new(100, 100),
})

Suite.Run("MockTransport", Client, 1001, "mock")

return nil
