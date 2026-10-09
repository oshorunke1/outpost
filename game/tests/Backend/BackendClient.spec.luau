--!strict
local Harness = require("@Tests/Harness")
local BackendClient = require("@Logic/Backend/BackendClient")
local CircuitBreaker = require("@Logic/Backend/CircuitBreaker")
local Requests = require("@Logic/Backend/Requests")
local RetryPolicy = require("@Logic/Backend/RetryPolicy")
local RateLimiter = require("@Logic/Net/RateLimiter")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

type Response = BackendClient.Response
type TransportRequest = BackendClient.TransportRequest

local function Reply(Status: number, Body: any?, Headers: { [string]: string }?): Response
	return { Ok = Status >= 200 and Status < 300, Status = Status, Body = Body, Headers = Headers or {} }
end

local function TokenReply(Token: string): Response
	return Reply(200, { accessToken = Token, expiresIn = 900, tokenType = "Bearer", scope = "game" })
end

type Rig = {
	Client: BackendClient.BackendClient,
	Calls: { TransportRequest },
	Slept: { number },
	Advance: (Seconds: number) -> (),
	Breaker: CircuitBreaker.CircuitBreaker,
	Breakers: BackendClient.Breakers,
}

local function NewBreakers(): BackendClient.Breakers
	return {
		Auth = CircuitBreaker.new(3, 30),
		Economy = CircuitBreaker.new(3, 30),
		Telemetry = CircuitBreaker.new(3, 30),
		Flags = CircuitBreaker.new(3, 30),
	}
end

-- A client whose transport answers from a script, one reply per call, then Status 0 forever.
-- A script entry can also be a function, which gets the request and answers it, so a test can
-- yield inside the transport the way HttpService does in game.
local function MakeRig(Script: { any }, Budget: any?, Transport: BackendClient.Transport?): Rig
	local Clock = 0
	local Calls: { TransportRequest } = {}
	local Slept: { number } = {}
	local Breakers = NewBreakers()
	local function ScriptedTransport(Request: TransportRequest): Response
		table.insert(Calls, Request)
		local Entry = Script[#Calls]
		if type(Entry) == "function" then
			return Entry(Request)
		end
		return Entry or Reply(0)
	end
	local Client = BackendClient.new({
		BaseUrl = "http://backend.test",
		Transport = Transport or ScriptedTransport,
		ApiKeyHeader = "ApiKey opk_game-server.secret",
		Now = function()
			return Clock
		end,
		Sleep = function(Seconds: number)
			table.insert(Slept, Seconds)
			Clock += Seconds
		end,
		RandomUnit = function()
			return 1
		end,
		Retry = RetryPolicy,
		Policy = RetryPolicy.Default,
		Breakers = Breakers,
		Budget = Budget or RateLimiter.new(100, 100),
	})
	return {
		Client = Client,
		Calls = Calls,
		Slept = Slept,
		Advance = function(Seconds: number)
			Clock += Seconds
		end,
		Breaker = Breakers.Economy,
		Breakers = Breakers,
	}
end

Describe("BackendClient tokens", function()
	It("trades the API key once and reuses the token", function()
		local Rig = MakeRig({ TokenReply("tok-1"), Reply(200, {}), Reply(200, {}) })
		Rig.Client:Send(Requests.Wallet(1001))
		Rig.Client:Send(Requests.Wallet(1001))
		Expect(#Rig.Calls).ToBe(3)
		Expect(Rig.Calls[1].Url).ToBe("http://backend.test/auth/service-token")
		Expect(Rig.Calls[1].Method).ToBe("POST")
		Expect(Rig.Calls[1].Headers.Authorization).ToBe("ApiKey opk_game-server.secret")
		Expect(Rig.Calls[2].Headers.Authorization).ToBe("Bearer tok-1")
		Expect(Rig.Calls[3].Url).ToBe("http://backend.test/v1/players/1001/wallet")
	end)

	It("gets a fresh token a minute before the old one runs out", function()
		local Rig =
			MakeRig({ TokenReply("tok-1"), Reply(200, {}), Reply(200, {}), TokenReply("tok-2"), Reply(200, {}) })
		Rig.Client:Send(Requests.Wallet(1001))
		Rig.Advance(839)
		Rig.Client:Send(Requests.Wallet(1001))
		Expect(Rig.Calls[3].Headers.Authorization).ToBe("Bearer tok-1")
		Rig.Advance(1)
		Rig.Client:Send(Requests.Wallet(1001))
		Expect(Rig.Calls[4].Url).ToBe("http://backend.test/auth/service-token")
		Expect(Rig.Calls[5].Headers.Authorization).ToBe("Bearer tok-2")
	end)

	It("a 401 drops the token, trades the key again and retries once", function()
		local Rig = MakeRig({ TokenReply("tok-1"), Reply(401), TokenReply("tok-2"), Reply(200, { balance = 3 }) })
		local Result = Rig.Client:Send(Requests.Wallet(1001))
		Expect(Result.Status).ToBe(200)
		Expect(Result.Body.balance).ToBe(3)
		Expect(Rig.Calls[4].Headers.Authorization).ToBe("Bearer tok-2")
	end)

	It("a second 401 in a row comes back as is, with no third exchange", function()
		local Rig = MakeRig({ TokenReply("tok-1"), Reply(401), TokenReply("tok-2"), Reply(401) })
		Expect(Rig.Client:Send(Requests.Wallet(1001)).Status).ToBe(401)
		Expect(#Rig.Calls).ToBe(4)
	end)

	It("a rejected API key comes back as the 401 from the exchange", function()
		local Rig = MakeRig({ Reply(401, { error = "invalid_api_key" }) })
		local Result = Rig.Client:Send(Requests.Wallet(1001))
		Expect(Result.Status).ToBe(401)
		Expect(Result.Body.error).ToBe("invalid_api_key")
		Expect(#Rig.Calls).ToBe(1)
	end)

	It("a failed exchange is not remembered, so the next send trades the key again", function()
		local Rig = MakeRig({ Reply(401), TokenReply("tok-1"), Reply(200, {}) })
		Expect(Rig.Client:Send(Requests.Wallet(1001)).Status).ToBe(401)
		Expect(Rig.Client:Send(Requests.Wallet(1001)).Status).ToBe(200)
		Expect(Rig.Calls[2].Url).ToBe("http://backend.test/auth/service-token")
	end)

	It("an exchange answer without a token string counts as no answer", function()
		local Rig = MakeRig({ Reply(200, { accessToken = 5 }) })
		Expect(Rig.Client:Send(Requests.Wallet(1001)).Status).ToBe(0)
		Expect(#Rig.Calls).ToBe(1)
	end)
end)

-- S6-F5. In game the transport yields, so many threads can call Send before the first exchange
-- comes back. They must all share that one exchange instead of each starting their own.
Describe("BackendClient single flight token exchange", function()
	local function YieldingRig(): (Rig, { thread }, { number })
		local Exchanges: { thread } = {}
		local Statuses: { number } = {}
		local Rig: Rig
		Rig = MakeRig({}, nil, function(Request: TransportRequest): Response
			table.insert(Rig.Calls, Request)
			if string.find(Request.Url, "/auth/service-token", 1, true) then
				table.insert(Exchanges, coroutine.running())
				return coroutine.yield()
			end
			return Reply(200, { auth = Request.Headers.Authorization })
		end)
		return Rig, Exchanges, Statuses
	end

	local function SendFive(Rig: Rig, Statuses: { number })
		for _ = 1, 5 do
			local Thread = coroutine.create(function()
				table.insert(Statuses, Rig.Client:Send(Requests.Wallet(1001)).Status)
			end)
			assert(coroutine.resume(Thread))
		end
	end

	It("five concurrent first sends make exactly one exchange and all use its token", function()
		local Rig, Exchanges, Statuses = YieldingRig()
		SendFive(Rig, Statuses)
		Expect(#Exchanges).ToBe(1)
		Expect(#Statuses).ToBe(0)
		assert(coroutine.resume(Exchanges[1], TokenReply("tok-1")))
		Expect(#Exchanges).ToBe(1)
		Expect(Statuses).ToEqual({ 200, 200, 200, 200, 200 })
		local Exchanged = 0
		for _, Call in Rig.Calls do
			if Call.Url == "http://backend.test/auth/service-token" then
				Exchanged += 1
			else
				Expect(Call.Headers.Authorization).ToBe("Bearer tok-1")
			end
		end
		Expect(Exchanged).ToBe(1)
		Expect(#Rig.Calls).ToBe(6)
	end)

	It("every waiter gets the error when the shared exchange fails, and nothing is cached", function()
		local Rig, Exchanges, Statuses = YieldingRig()
		SendFive(Rig, Statuses)
		assert(coroutine.resume(Exchanges[1], Reply(401, { error = "invalid_api_key" })))
		Expect(Statuses).ToEqual({ 401, 401, 401, 401, 401 })
		Expect(#Rig.Calls).ToBe(1)
		SendFive(Rig, Statuses)
		Expect(#Exchanges).ToBe(2)
	end)
end)

Describe("BackendClient retries and breaker", function()
	It("retries a 503 with backoff and gives up after three attempts", function()
		local Rig = MakeRig({ TokenReply("tok-1"), Reply(503), Reply(503), Reply(503) })
		Expect(Rig.Client:Send(Requests.Wallet(1001)).Status).ToBe(503)
		Expect(Rig.Slept).ToEqual({ 0.5, 1 })
		Expect(#Rig.Calls).ToBe(4)
	end)

	It("never retries a definite answer like 422", function()
		local Rig = MakeRig({ TokenReply("tok-1"), Reply(422, { error = "insufficient_funds" }) })
		Expect(Rig.Client:Send(Requests.Purchase(1001, "GoldCrown", "key-123456")).Status).ToBe(422)
		Expect(#Rig.Slept).ToBe(0)
	end)

	It("a retried earn sends the same Idempotency-Key and body every time", function()
		local Rig = MakeRig({ TokenReply("tok-1"), Reply(0), Reply(503), Reply(201, {}) })
		Expect(Rig.Client:Send(Requests.Earn(1001, 10, "job-1:1001:1")).Status).ToBe(201)
		for Index = 2, 4 do
			Expect(Rig.Calls[Index].Headers["Idempotency-Key"]).ToBe("job-1:1001:1")
			Expect(Rig.Calls[Index].Body).ToEqual({ kind = "earn", userId = 1001, amount = 10, reason = "orbs" })
		end
	end)

	It("an open breaker refuses at once without touching the transport", function()
		local Rig = MakeRig({ TokenReply("tok-1") })
		Expect(Rig.Client:Send(Requests.Wallet(1001)).Status).ToBe(0)
		Expect(Rig.Breaker:State()).ToBe("Open")
		local CallsBefore = #Rig.Calls
		local Refused = Rig.Client:Send(Requests.Wallet(1001))
		Expect(Refused.Status).ToBe(BackendClient.BreakerOpen)
		Expect(Refused.Ok).ToBe(false)
		Expect(Refused.Headers).ToEqual({})
		Expect(#Rig.Calls).ToBe(CallsBefore)
	end)

	It("an empty budget answers OverBudget and is not a breaker failure", function()
		local Rig = MakeRig({ TokenReply("tok-1") }, RateLimiter.new(1, 0.001))
		Expect(Rig.Client:Send(Requests.Wallet(1001)).Status).ToBe(BackendClient.OverBudget)
		Expect(#Rig.Calls).ToBe(1)
		Expect(Rig.Breaker:State()).ToBe("Closed")
	end)

	-- Review Focus 5. The budget is checked before the breaker, so a call the budget refuses never
	-- takes the single half open probe and leaves the breaker waiting on a call that was never sent.
	It("a half open probe refused by the budget does not wedge the breaker", function()
		local Allowing = true
		local Budget = {
			Allow = function(_Self: any, _Key: string, _Now: number): boolean
				return Allowing
			end,
		}
		local Rig = MakeRig({ TokenReply("tok-1"), Reply(0), Reply(0), Reply(0), Reply(200, {}) }, Budget)
		Rig.Client:Send(Requests.Wallet(1001))
		Expect(Rig.Breaker:State()).ToBe("Open")
		Rig.Advance(30)
		Allowing = false
		Expect(Rig.Client:Send(Requests.Wallet(1001)).Status).ToBe(BackendClient.OverBudget)
		Expect(Rig.Breaker:State()).ToBe("Open")
		Allowing = true
		Expect(Rig.Client:Send(Requests.Wallet(1001)).Status).ToBe(200)
		Expect(Rig.Breaker:State()).ToBe("Closed")
	end)

	It("sends JSON with the Idempotency-Key and a content type", function()
		local Rig = MakeRig({ TokenReply("tok-1"), Reply(201, {}) })
		local Request = Requests.Earn(1001, 10, "job-1:1001:1")
		Rig.Client:Send(Request)
		local Call = Rig.Calls[2]
		Expect(Call.Method).ToBe("POST")
		Expect(Call.Headers["Idempotency-Key"]).ToBe("job-1:1001:1")
		Expect(Call.Headers["Content-Type"]).ToBe("application/json")
		Expect(Call.Body.amount).ToBe(10)
		Expect((Request.Headers :: any).Authorization).ToBeNil()
	end)

	It("a GET carries no body and no content type", function()
		local Rig = MakeRig({ TokenReply("tok-1"), Reply(200, {}) })
		Rig.Client:Send(Requests.Flags())
		Expect(Rig.Calls[2].Body).ToBeNil()
		Expect(Rig.Calls[2].Headers["Content-Type"]).ToBeNil()
	end)

	It("a 204 has no body, even if the transport hands one back", function()
		local Rig = MakeRig({ TokenReply("tok-1"), Reply(204, "") })
		local Result = Rig.Client:Send(Requests.LeaveSession(1001))
		Expect(Result.Status).ToBe(204)
		Expect(Result.Ok).ToBe(true)
		Expect(Result.Body).ToBeNil()
	end)

	It("a transport that throws counts as no answer instead of breaking the caller", function()
		local Rig = MakeRig({
			TokenReply("tok-1"),
			function(): Response
				error("socket blew up")
			end,
			Reply(200, {}),
		})
		Expect(Rig.Client:Send(Requests.Wallet(1001)).Status).ToBe(200)
		Expect(Rig.Slept).ToEqual({ 0.5 })
	end)

	It("a response without headers is treated as having none", function()
		local Rig = MakeRig({ TokenReply("tok-1"), { Ok = true, Status = 200, Body = {} } :: any })
		Expect(Rig.Client:Send(Requests.Wallet(1001)).Headers).ToEqual({})
	end)
end)

-- Task 24 carry and S6-F4. The server's Retry-After is honoured on a 429 and on a 503, with our own
-- jittered backoff on top, and a 429 never opens a breaker.
Describe("BackendClient Retry-After", function()
	It("waits out a 429's Retry-After and its backoff, then succeeds", function()
		local Rig = MakeRig({ TokenReply("tok-1"), Reply(429, nil, { ["retry-after"] = "7" }), Reply(200, {}) })
		Expect(Rig.Client:Send(Requests.Wallet(1001)).Status).ToBe(200)
		Expect(Rig.Slept).ToEqual({ 7.5 })
	end)

	It("honours Retry-After on a 503 too", function()
		local Rig = MakeRig({ TokenReply("tok-1"), Reply(503, nil, { ["retry-after"] = "3" }), Reply(201, {}) })
		Expect(Rig.Client:Send(Requests.Earn(1001, 5, "job-1:1001:1")).Status).ToBe(201)
		Expect(Rig.Slept).ToEqual({ 3.5 })
	end)

	It("a run of 429s never opens the breaker", function()
		local Script = { TokenReply("tok-1") }
		for _ = 1, 9 do
			table.insert(Script, Reply(429, nil, { ["retry-after"] = "1" }))
		end
		local Rig = MakeRig(Script)
		for _ = 1, 3 do
			Expect(Rig.Client:Send(Requests.Wallet(1001)).Status).ToBe(429)
		end
		Expect(Rig.Breaker:State()).ToBe("Closed")
		Expect(#Rig.Calls).ToBe(10)
	end)

	It("a token exchange answered 429 waits its Retry-After and tries again", function()
		local Rig = MakeRig({ Reply(429, nil, { ["retry-after"] = "2" }), TokenReply("tok-1"), Reply(200, {}) })
		Expect(Rig.Client:Send(Requests.Wallet(1001)).Status).ToBe(200)
		Expect(Rig.Slept).ToEqual({ 2.5 })
	end)
end)

Describe("BackendClient deadline", function()
	It("returns RetryLater at once when a Retry-After would pass a short deadline", function()
		local Rig = MakeRig({ TokenReply("tok-1"), Reply(429, nil, { ["retry-after"] = "30" }) })
		local Result = Rig.Client:Send(Requests.Purchase(1001, "RedHat", "key-123456"), { DeadlineSeconds = 10 })
		Expect(Result.Status).ToBe(BackendClient.RetryLater)
		Expect(Result.Ok).ToBe(false)
		Expect(Result.Headers["retry-after"]).ToBe("30")
		Expect(#Rig.Slept).ToBe(0)
		Expect(#Rig.Calls).ToBe(2)
	end)

	It("keeps retrying while the waits still fit the deadline", function()
		local Rig = MakeRig({ TokenReply("tok-1"), Reply(503), Reply(503), Reply(200, {}) })
		local Result = Rig.Client:Send(Requests.Wallet(1001), { DeadlineSeconds = 10 })
		Expect(Result.Status).ToBe(200)
		Expect(Rig.Slept).ToEqual({ 0.5, 1 })
	end)

	It("the default deadline is generous enough for a full Retry-After", function()
		Expect(BackendClient.DefaultDeadlineSeconds >= 2 * (RetryPolicy.MaxRetryAfter + 4)).ToBe(true)
		local Rig = MakeRig({ TokenReply("tok-1"), Reply(429, nil, { ["retry-after"] = "30" }), Reply(200, {}) })
		Expect(Rig.Client:Send(Requests.Wallet(1001)).Status).ToBe(200)
		Expect(Rig.Slept).ToEqual({ 30.5 })
	end)

	It("the deadline covers the token exchange as well", function()
		local Rig = MakeRig({ Reply(429, nil, { ["retry-after"] = "9" }) })
		local Result = Rig.Client:Send(Requests.Wallet(1001), { DeadlineSeconds = 5 })
		Expect(Result.Status).ToBe(BackendClient.RetryLater)
		Expect(#Rig.Calls).ToBe(1)
		Expect(#Rig.Slept).ToBe(0)
	end)

	It("refusals made here are all below zero and distinct", function()
		Expect(BackendClient.BreakerOpen).ToBe(-1)
		Expect(BackendClient.OverBudget).ToBe(-2)
		Expect(BackendClient.RetryLater).ToBe(-3)
	end)
end)

-- Task 24 carry. One breaker per route group, so a ledger_unavailable storm on the economy routes
-- cannot block telemetry or flags.
Describe("BackendClient breaker per route group", function()
	It("maps every route to its group", function()
		Expect(BackendClient.GroupFor("/auth/service-token")).ToBe("Auth")
		Expect(BackendClient.GroupFor(Requests.Earn(1, 5, "job-1:1:1").Path)).ToBe("Economy")
		Expect(BackendClient.GroupFor(Requests.Fulfilled("00000000-0000-4000-8000-000000000001").Path)).ToBe("Economy")
		Expect(BackendClient.GroupFor(Requests.Wallet(1).Path)).ToBe("Economy")
		Expect(BackendClient.GroupFor(Requests.JoinSession(1).Path)).ToBe("Economy")
		Expect(BackendClient.GroupFor(Requests.Unfulfilled(1).Path)).ToBe("Economy")
		Expect(BackendClient.GroupFor(Requests.TelemetryBatch({}).Path)).ToBe("Telemetry")
		Expect(BackendClient.GroupFor(Requests.Flags().Path)).ToBe("Flags")
	end)

	It("a ledger 503 storm opens only the economy breaker", function()
		local Unavailable = { error = "ledger_unavailable" }
		local Rig = MakeRig({
			TokenReply("tok-1"),
			Reply(503, Unavailable),
			Reply(503, Unavailable),
			Reply(503, Unavailable),
			Reply(202, { accepted = 1 }),
			Reply(200, { flags = {} }),
		})
		Expect(Rig.Client:Send(Requests.Earn(1001, 5, "job-1:1001:1")).Status).ToBe(503)
		Expect(Rig.Client:BreakerState("Economy")).ToBe("Open")
		Expect(Rig.Client:Send(Requests.Purchase(1001, "RedHat", "key-123456")).Status).ToBe(BackendClient.BreakerOpen)
		Expect(Rig.Client:Send(Requests.TelemetryBatch({ { name = "player_join", ts = 1 } })).Status).ToBe(202)
		Expect(Rig.Client:Send(Requests.Flags()).Status).ToBe(200)
		Expect(Rig.Client:BreakerState("Telemetry")).ToBe("Closed")
		Expect(Rig.Client:BreakerState("Flags")).ToBe("Closed")
		Expect(Rig.Client:BreakerState("Auth")).ToBe("Closed")
	end)

	It("BreakerState with no group reports the worst one", function()
		local Rig = MakeRig({})
		Expect(Rig.Client:BreakerState()).ToBe("Closed")
		Rig.Breakers.Flags:RecordFailure(0)
		Rig.Breakers.Flags:RecordFailure(0)
		Rig.Breakers.Flags:RecordFailure(0)
		Rig.Breakers.Telemetry:RecordFailure(0)
		Rig.Breakers.Telemetry:RecordFailure(0)
		Rig.Breakers.Telemetry:RecordFailure(0)
		Rig.Advance(30)
		Rig.Breakers.Telemetry:Allow(30)
		Expect(Rig.Client:BreakerState("Telemetry")).ToBe("HalfOpen")
		Expect(Rig.Client:BreakerState()).ToBe("Open")
		Rig.Breakers.Flags:RecordSuccess(30)
		Expect(Rig.Client:BreakerState()).ToBe("HalfOpen")
	end)

	It("an open auth breaker refuses the exchange and so the call", function()
		local Rig = MakeRig({})
		Expect(Rig.Client:Send(Requests.Wallet(1001)).Status).ToBe(0)
		Expect(Rig.Client:BreakerState("Auth")).ToBe("Open")
		Expect(Rig.Client:BreakerState("Economy")).ToBe("Closed")
		Expect(Rig.Client:Send(Requests.Wallet(1001)).Status).ToBe(BackendClient.BreakerOpen)
		Expect(#Rig.Calls).ToBe(3)
	end)

	It("refuses to start without a breaker for every group", function()
		Expect(function()
			BackendClient.new({
				BaseUrl = "http://backend.test",
				Transport = function(_Request: TransportRequest): Response
					return Reply(0)
				end,
				ApiKeyHeader = "ApiKey x",
				Now = os.clock,
				Sleep = function(_Seconds: number) end,
				RandomUnit = math.random,
				Retry = RetryPolicy,
				Policy = RetryPolicy.Default,
				Breakers = { Auth = CircuitBreaker.new(3, 30) } :: any,
				Budget = RateLimiter.new(1, 1),
			})
		end).ToThrow("Economy")
	end)
end)

-- Task 25 fix round 1. The deadline also holds for a thread that waited on someone else's token
-- exchange, the shared exchange is capped, and a stuck exchange is replaced instead of waited on.
Describe("BackendClient deadline and the shared exchange", function()
	local function Count(Calls: { TransportRequest }, Path: string): number
		local Found = 0
		for _, Call in Calls do
			if Call.Url == `http://backend.test{Path}` then
				Found += 1
			end
		end
		return Found
	end

	-- Runs Send on its own thread and hands back a table that gets the result once it finishes.
	local function Spawn(Rig: Rig, Request: any, Options: any?): { Result: Response? }
		local Holder: { Result: Response? } = { Result = nil }
		local Thread = coroutine.create(function()
			Holder.Result = Rig.Client:Send(Request, Options)
		end)
		assert(coroutine.resume(Thread))
		return Holder
	end

	-- Token exchanges yield until the test resumes them, every other call answers 200 at once.
	local function ExchangeRig(): (Rig, { thread })
		local Exchanges: { thread } = {}
		local Rig: Rig
		Rig = MakeRig({}, nil, function(Request: TransportRequest): Response
			table.insert(Rig.Calls, Request)
			if string.find(Request.Url, "/auth/service-token", 1, true) then
				table.insert(Exchanges, coroutine.running())
				return coroutine.yield()
			end
			return Reply(200, {})
		end)
		return Rig, Exchanges
	end

	-- The reviewer's repro. A purchase with a 10 s deadline joins a background call's exchange,
	-- which only comes back at 100 s. The purchase must give up without ever being sent.
	It("a 10 s purchase that waited on a slow shared exchange gets RetryLater and is never sent", function()
		local Rig, Exchanges = ExchangeRig()
		local Background = Spawn(Rig, Requests.Wallet(1001))
		local Purchase = Spawn(Rig, Requests.Purchase(1001, "RedHat", "key-123456"), { DeadlineSeconds = 10 })
		Expect(#Exchanges).ToBe(1)
		Rig.Advance(100)
		assert(coroutine.resume(Exchanges[1], TokenReply("tok-1")))
		Expect((Purchase.Result :: Response).Status).ToBe(BackendClient.RetryLater)
		Expect(Count(Rig.Calls, "/v1/economy/transactions")).ToBe(0)
		Expect((Background.Result :: Response).Status).ToBe(200)
	end)

	It("a call whose deadline passed during the 401 refresh is not sent again", function()
		local Rig: Rig
		Rig = MakeRig({
			TokenReply("tok-1"),
			function(): Response
				Rig.Advance(20)
				return Reply(401)
			end,
			TokenReply("tok-2"),
		})
		local Result = Rig.Client:Send(Requests.Wallet(1001), { DeadlineSeconds = 10 })
		Expect(Result.Status).ToBe(BackendClient.RetryLater)
		Expect(#Rig.Calls).ToBe(2)
	end)

	It("the shared exchange is capped, so a long Retry-After on it gives RetryLater at once", function()
		Expect(BackendClient.ExchangeDeadlineSeconds).ToBe(10)
		local Rig = MakeRig({ Reply(429, nil, { ["retry-after"] = "30" }), TokenReply("tok-1"), Reply(200, {}) })
		Expect(Rig.Client:Send(Requests.Wallet(1001)).Status).ToBe(BackendClient.RetryLater)
		Expect(#Rig.Slept).ToBe(0)
		Expect(Rig.Client:Send(Requests.Wallet(1001)).Status).ToBe(200)
	end)

	It("a stuck exchange is waited on while it is young and replaced once it is stale", function()
		local Rig, Exchanges = ExchangeRig()
		local First = Spawn(Rig, Requests.Wallet(1001))
		Rig.Advance(BackendClient.ExchangeStaleSeconds - 1)
		local Young = Spawn(Rig, Requests.Wallet(1002))
		Expect(#Exchanges).ToBe(1)
		Rig.Advance(1)
		local Late = Spawn(Rig, Requests.Wallet(1003))
		Expect(#Exchanges).ToBe(2)
		assert(coroutine.resume(Exchanges[2], TokenReply("tok-2")))
		Expect((Late.Result :: Response).Status).ToBe(200)
		Expect((Young.Result :: Response).Status).ToBe(200)
		Expect(First.Result).ToBeNil()
		-- The stuck one finally answers. Its own caller goes ahead, but the newer token stays.
		assert(coroutine.resume(Exchanges[1], TokenReply("tok-1")))
		Expect((First.Result :: Response).Status).ToBe(200)
		Rig.Client:Send(Requests.Wallet(1004))
		Expect(Rig.Calls[#Rig.Calls].Headers.Authorization).ToBe("Bearer tok-2")
		Expect(#Exchanges).ToBe(2)
	end)

	It("the default Resume passes on a waiter's error instead of swallowing it", function()
		local Rig, Exchanges = ExchangeRig()
		Spawn(Rig, Requests.Wallet(1001))
		-- The broken waiter goes first, so a client that raises before waking the rest is caught.
		local Broken = coroutine.create(function()
			Rig.Client:Send(Requests.Wallet(1003))
			error("waiter blew up")
		end)
		assert(coroutine.resume(Broken))
		local Fine = Spawn(Rig, Requests.Wallet(1002))
		local Resumed, Err = coroutine.resume(Exchanges[1], TokenReply("tok-1"))
		Expect(Resumed).ToBe(false)
		Expect(string.find(tostring(Err), "waiter blew up", 1, true) ~= nil).ToBe(true)
		Expect((Fine.Result :: Response).Status).ToBe(200)
	end)

	It("a 401 from a call that still used the old token does not throw away the new one", function()
		local Tokens = 0
		local Held: { thread } = {}
		local Rig: Rig
		Rig = MakeRig({}, nil, function(Request: TransportRequest): Response
			table.insert(Rig.Calls, Request)
			if string.find(Request.Url, "/auth/service-token", 1, true) then
				Tokens += 1
				return TokenReply(`tok-{Tokens}`)
			end
			table.insert(Held, coroutine.running())
			return coroutine.yield()
		end)
		Spawn(Rig, Requests.Wallet(1001))
		Spawn(Rig, Requests.Wallet(1002))
		Expect(#Held).ToBe(2)
		assert(coroutine.resume(Held[1], Reply(401)))
		Expect(Tokens).ToBe(2)
		assert(coroutine.resume(Held[2], Reply(401)))
		Expect(Tokens).ToBe(2)
		Expect(Rig.Calls[#Rig.Calls].Headers.Authorization).ToBe("Bearer tok-2")
	end)

	It("a 403 is returned as is and never triggers a token refresh", function()
		local Rig = MakeRig({ TokenReply("tok-1"), Reply(403, { error = "forbidden" }), TokenReply("tok-2") })
		Expect(Rig.Client:Send(Requests.Wallet(1001)).Status).ToBe(403)
		Expect(#Rig.Calls).ToBe(2)
	end)

	It("an error thrown inside the exchange never wedges the client", function()
		local Throwing = true
		local Budget = {
			Allow = function(_Self: any, _Key: string, _Now: number): boolean
				if Throwing then
					Throwing = false
					error("budget blew up")
				end
				return true
			end,
		}
		local Rig = MakeRig({ TokenReply("tok-1"), Reply(200, {}) }, Budget)
		local Worked, Result = pcall(function()
			return Rig.Client:Send(Requests.Wallet(1001))
		end)
		Expect(Worked).ToBe(true)
		Expect((Result :: Response).Status).ToBe(0)
		Expect(Rig.Client:Send(Requests.Wallet(1001)).Status).ToBe(200)
		Expect(Rig.Calls[1].Url).ToBe("http://backend.test/auth/service-token")
	end)
end)

return nil
