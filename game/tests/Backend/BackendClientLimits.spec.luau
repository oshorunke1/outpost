--!strict
-- How BackendClient tells the transport its time left, and how it treats the refusals a
-- transport makes itself. Split from BackendClient.spec to keep both under 700 lines.
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

Describe("BackendClient time left for each request", function()
	It("tells the transport how long the call has left, so a request never outlives the deadline", function()
		local Rig = MakeRig({ TokenReply("tok-1"), Reply(503), Reply(200, {}) })
		Rig.Client:Send(Requests.Wallet(1001), { DeadlineSeconds = 8 })
		Expect(#Rig.Calls).ToBe(3)
		-- The trade gets the smaller of the call's deadline and its own cap.
		Expect(Rig.Calls[1].TimeoutSeconds).ToBe(8)
		Expect(Rig.Calls[2].TimeoutSeconds).ToBe(8)
		-- After the backoff wait, the retry has that much less time.
		Expect(Rig.Slept[1] > 0).ToBe(true)
		Expect(Rig.Calls[3].TimeoutSeconds).ToBe(8 - Rig.Slept[1])
	end)

	It("the token trade never gets more than its own cap", function()
		local Rig = MakeRig({ TokenReply("tok-1"), Reply(200, {}) })
		Rig.Client:Send(Requests.Wallet(1001))
		Expect(Rig.Calls[1].TimeoutSeconds).ToBe(BackendClient.ExchangeDeadlineSeconds)
		Expect(Rig.Calls[2].TimeoutSeconds).ToBe(BackendClient.DefaultDeadlineSeconds)
	end)

	It("time spent on the token trade comes off the request that follows", function()
		local Advance: ((Seconds: number) -> ())? = nil
		local Rig = MakeRig({
			function(_Request: TransportRequest): Response
				if Advance then
					Advance(3)
				end
				return TokenReply("tok-1")
			end,
			Reply(200, {}),
		})
		Advance = Rig.Advance
		Rig.Client:Send(Requests.Wallet(1001), { DeadlineSeconds = 8 })
		Expect(Rig.Calls[2].TimeoutSeconds).ToBe(5)
	end)
end)

Describe("BackendClient refusals from the transport", function()
	It("an unencodable body or an Offline server is never retried and never opens the breaker", function()
		for _, Status in { BackendClient.Unencodable, BackendClient.Offline } do
			local Script: { any } = { TokenReply("tok-1") }
			for _ = 1, 6 do
				table.insert(Script, Reply(Status))
			end
			local Rig = MakeRig(Script)
			for _ = 1, 6 do
				Expect(Rig.Client:Send(Requests.Wallet(1001)).Status).ToBe(Status)
			end
			Expect(#Rig.Calls).ToBe(7)
			Expect(#Rig.Slept).ToBe(0)
			Expect(Rig.Client:BreakerState()).ToBe("Closed")
		end
	end)

	It("an Offline token trade fails at once, without retries", function()
		local Rig = MakeRig({ Reply(BackendClient.Offline) })
		Expect(Rig.Client:Send(Requests.Wallet(1001)).Status).ToBe(BackendClient.Offline)
		Expect(#Rig.Calls).ToBe(1)
		Expect(#Rig.Slept).ToBe(0)
	end)

	It("the refusal statuses are all different", function()
		local Seen: { [number]: boolean } = {}
		for _, Status in
			{
				BackendClient.BreakerOpen,
				BackendClient.OverBudget,
				BackendClient.RetryLater,
				BackendClient.Unencodable,
				BackendClient.Offline,
			}
		do
			Expect(Status < 0).ToBe(true)
			Expect(Seen[Status]).ToBeNil()
			Seen[Status] = true
		end
	end)
end)

return nil
