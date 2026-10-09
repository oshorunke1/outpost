--!strict
-- Runs the backend contract suite against a real Outpost backend, through the same BackendClient
-- the game uses, with LuneTransport in place of RobloxTransport.
-- Run it from the game folder with lune run tests/Contract/Run once a backend is up.
-- It needs OUTPOST_BACKEND_URL and OUTPOST_GAME_API_KEY in the environment. CI sets both.
-- Every run picks new players and a new key prefix, so it passes again and again on one database.
-- It never prints the key.
local DateTime = require("@lune/datetime")
local Process = require("@lune/process")
local Task = require("@lune/task")
local Harness = require("@Tests/Harness")
local LuneTransport = require("@Tests/Support/LuneTransport")
local Suite = require("@Tests/Contract/Suite")
local BackendClient = require("@Logic/Backend/BackendClient")
local CircuitBreaker = require("@Logic/Backend/CircuitBreaker")
local RetryPolicy = require("@Logic/Backend/RetryPolicy")
local RateLimiter = require("@Logic/Net/RateLimiter")

-- Contract players live far above any Roblox user id today and above the ids pnpm demo picks,
-- which stay under this one.
local FirstContractId = 10000000000000

local BaseUrl = Process.env.OUTPOST_BACKEND_URL
local ApiKey = Process.env.OUTPOST_GAME_API_KEY
if BaseUrl == nil or BaseUrl == "" or ApiKey == nil or ApiKey == "" then
	print("set OUTPOST_BACKEND_URL and OUTPOST_GAME_API_KEY first")
	Process.exit(1)
end
local Url = string.gsub(BaseUrl :: string, "/+$", "")

local Client = BackendClient.new({
	BaseUrl = Url,
	Transport = LuneTransport.Send,
	ApiKeyHeader = `ApiKey {ApiKey}`,
	Now = os.clock,
	Sleep = function(Seconds: number)
		Task.wait(Seconds)
	end,
	RandomUnit = math.random,
	Retry = RetryPolicy,
	Policy = RetryPolicy.Default,
	Breakers = {
		Auth = CircuitBreaker.new(5, 30),
		Economy = CircuitBreaker.new(5, 30),
		Telemetry = CircuitBreaker.new(5, 30),
		Flags = CircuitBreaker.new(5, 30),
	},
	Budget = RateLimiter.new(100, 100),
	Resume = function(Thread: thread, ...: any)
		Task.spawn(Thread, ...)
	end,
})

-- The suite uses UserId, UserId plus 1 and UserId plus 2. Every millisecond of wall clock owns its
-- own three ids, and a run takes far longer than that, so two runs in a row never share a player.
local Millis = DateTime.now().unixTimestampMillis
local UserId = FirstContractId + (Millis % 1000000000000) * 3
local KeyPrefix = string.format("contract-%d", UserId)
Suite.Run("real backend", Client, UserId, KeyPrefix)

local Passed = 0
local Failed = 0
for _, Result in Harness.TakeResults() do
	if Result.Passed then
		Passed += 1
		print(`PASS  {Result.Name}`)
	else
		Failed += 1
		print(`FAIL  {Result.Name}\n      {Result.Message}`)
	end
end
local Players = string.format("%d to %d", UserId, UserId + 2)
print(`\n{Passed} passed, {Failed} failed against {Url} as players {Players}`)
Process.exit(if Failed > 0 or Passed == 0 then 1 else 0)
