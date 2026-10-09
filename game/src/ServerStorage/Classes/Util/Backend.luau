--!strict
-- Backend owns the one BackendClient this server uses and picks how it reaches the backend.
-- Shared BackendMode makes the choice, and its Lune spec covers every case.
-- Studio uses MockTransport, so the game always runs there.
-- A live server uses RobloxTransport only when Configs/Backend is turned on and the API key is in
-- the Secrets Store. The key is sent as an ApiKey header and never appears in code or the place.
-- Any other live server is Offline. It sends nothing and every call is refused at once.
-- EconomyLive is the cut over switch for the economy. A live server only turns it on in Roblox
-- mode, so it never keeps Coins in the mock's memory.
local HttpService = game:GetService("HttpService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local ServerStorage = game:GetService("ServerStorage")

local Shared = ReplicatedStorage.Shared
local BackendClient = require(Shared.Logic.Backend.BackendClient)
local BackendMode = require(Shared.Logic.Backend.BackendMode)
local CircuitBreaker = require(Shared.Logic.Backend.CircuitBreaker)
local MockTransport = require(Shared.Logic.Backend.MockTransport)
local RetryPolicy = require(Shared.Logic.Backend.RetryPolicy)
local RateLimiter = require(Shared.Logic.Net.RateLimiter)
local Flags = require(Shared.Configs.Flags)
local Shop = require(Shared.Configs.Shop)
local Telemetry = require(Shared.Configs.Telemetry)
local BackendConfig = require(ServerStorage.Configs.Backend)
local RobloxTransport = require(ServerStorage.Classes.Util.RobloxTransport)

-- Five failures in a row open a group's breaker for 30 seconds.
local BreakerFailures = 5
local BreakerOpenSeconds = 30

local Backend = {}

local Client: BackendClient.BackendClient? = nil
local Mode: BackendMode.Mode = "Offline"
local Controls: MockTransport.Controls? = nil
local Rng = Random.new()

local function NowMillis(): number
	return DateTime.now().UnixTimestampMillis
end

local function NewBreakers(): BackendClient.Breakers
	return {
		Auth = CircuitBreaker.new(BreakerFailures, BreakerOpenSeconds),
		Economy = CircuitBreaker.new(BreakerFailures, BreakerOpenSeconds),
		Telemetry = CircuitBreaker.new(BreakerFailures, BreakerOpenSeconds),
		Flags = CircuitBreaker.new(BreakerFailures, BreakerOpenSeconds),
	}
end

-- Hands back the transport, the Authorization value for the token trade and the mode.
local function PickTransport(): (BackendClient.Transport, any, BackendMode.Mode)
	local Secret: Secret? = nil
	local Picked = BackendMode.Pick(RunService:IsStudio(), BackendConfig.Enabled, function()
		local Found, Value = pcall(function()
			return HttpService:GetSecret(BackendConfig.SecretName)
		end)
		if Found then
			Secret = Value
		end
		return Found
	end)
	if Picked == "Mock" then
		local Transport, MockControls = MockTransport.new(Shop, Flags :: any, Telemetry, NowMillis)
		Controls = MockControls
		return Transport, "ApiKey studio-mock", Picked
	end
	local Found = Secret
	if Picked == "Roblox" and Found ~= nil then
		return RobloxTransport.Send, Found:AddPrefix("ApiKey "), Picked
	end
	if BackendConfig.Enabled then
		warn(`[Backend] the secret {BackendConfig.SecretName} is missing, so this server sends nothing`)
	end
	return BackendMode.Offline, "ApiKey offline", "Offline"
end

-- The one client for this server. Making it never yields, so two threads that ask at the same
-- moment still share one client.
function Backend.Client(): BackendClient.BackendClient
	local Existing = Client
	if Existing ~= nil then
		return Existing
	end
	local Transport, ApiKeyHeader, Picked = PickTransport()
	local Created = BackendClient.new({
		BaseUrl = BackendConfig.BaseUrl,
		Transport = Transport,
		ApiKeyHeader = ApiKeyHeader,
		Now = os.clock,
		Sleep = function(Seconds: number)
			task.wait(Seconds)
		end,
		RandomUnit = function()
			return Rng:NextNumber()
		end,
		Retry = RetryPolicy,
		Policy = RetryPolicy.Default,
		Breakers = NewBreakers(),
		Budget = RateLimiter.new(BackendConfig.HttpBurst, BackendConfig.HttpBudgetPerMinute / 60),
		Resume = function(Thread: thread, ...: any)
			task.spawn(Thread, ...)
		end,
	})
	Client = Created
	Mode = Picked :: BackendMode.Mode
	print(`[Backend] using the {Picked} transport`)
	return Created
end

-- Mock in Studio, Roblox on a live server that talks to the backend, and Offline otherwise.
function Backend.Mode(): BackendMode.Mode
	Backend.Client()
	return Mode
end

-- The economy switch. True only in Roblox mode, or in Studio with StudioLedger turned on.
-- While it is false the economy keeps the old DataStore Coins. A live server with the backend
-- turned on but no secret is Offline, so it stays false there too.
function Backend.EconomyLive(): boolean
	return BackendMode.EconomyLive(Backend.Mode(), BackendConfig.StudioLedger)
end

-- The mock's fault switches, so a Studio tester can fail the next call from the command bar.
-- Nil on any server that is not using the mock.
function Backend.MockControls(): MockTransport.Controls?
	Backend.Client()
	return Controls
end

return Backend
