--!strict
-- MockTransport has to answer and refuse the way the backend does, so these specs walk through
-- what the backend validates, one rule at a time. The shared contract suite then runs the same
-- story against the mock here and against the real backend in CI.
local Fs = require("@lune/fs")
local Harness = require("@Tests/Harness")
local BackendClient = require("@Logic/Backend/BackendClient")
local CircuitBreaker = require("@Logic/Backend/CircuitBreaker")
local FlagValues = require("@Logic/Backend/FlagValues")
local MockTransport = require("@Logic/Backend/MockTransport")
local PurchaseFlow = require("@Logic/Backend/PurchaseFlow")
local Requests = require("@Logic/Backend/Requests")
local RetryPolicy = require("@Logic/Backend/RetryPolicy")
local RateLimiter = require("@Logic/Net/RateLimiter")
local Flags = require("@Configs/Flags")
local Shop = require("@Configs/Shop")
local Telemetry = require("@Configs/Telemetry")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

type Response = BackendClient.Response

-- A fixed wall clock in Unix milliseconds, so the clock skew checks are exact.
local NowMs = 1800000000000

local HatKey = "spec:buy:hat-1"
local Uuid = "00000000-0000-4000-8000-000000000999"

type Rig = {
	Transport: BackendClient.Transport,
	Controls: MockTransport.Controls,
	Call: (Method: string, Path: string, Body: any?, Headers: { [string]: any }?) -> Response,
}

local function Make(FlagsOverride: any?): Rig
	local Transport, Controls = MockTransport.new(Shop, FlagsOverride or Flags, Telemetry, function()
		return NowMs
	end)
	local Token: string? = nil
	local function Call(Method: string, Path: string, Body: any?, Headers: { [string]: any }?): Response
		if Token == nil then
			Token = Transport({
				Method = "POST",
				Url = "http://mock/auth/service-token",
				Headers = { Authorization = "ApiKey mock" },
				Body = {},
			}).Body.accessToken
		end
		local Sent: { [string]: any } = table.clone(Headers or {})
		Sent.Authorization = Sent.Authorization or `Bearer {Token}`
		return Transport({ Method = Method, Url = `http://mock{Path}`, Headers = Sent, Body = Body })
	end
	return { Transport = Transport, Controls = Controls, Call = Call }
end

local function Earn(Rig: Rig, UserId: number, Amount: any, Key: string, Extra: { [string]: any }?): Response
	local Body: { [string]: any } = { kind = "earn", userId = UserId, amount = Amount, reason = "orbs" }
	for Field, Value in Extra or {} do
		Body[Field] = Value
	end
	return Rig.Call("POST", "/v1/economy/transactions", Body, { ["Idempotency-Key"] = Key })
end

local function Buy(Rig: Rig, UserId: number, ItemId: string, Key: string): Response
	return Rig.Call(
		"POST",
		"/v1/economy/transactions",
		{ kind = "purchase", userId = UserId, itemId = ItemId },
		{ ["Idempotency-Key"] = Key }
	)
end

local function Joined(UserId: number, Coins: number?): Rig
	local Rig = Make()
	Rig.Call("POST", `/v1/players/{UserId}/sessions`, {})
	if Coins then
		Earn(Rig, UserId, Coins, `spec:seed:{UserId}`)
	end
	return Rig
end

local function Event(Fields: { [string]: any }?): { [string]: any }
	local Built: { [string]: any } = { name = "player_join", ts = NowMs, userId = 1001 }
	for Field, Value in Fields or {} do
		Built[Field] = Value
	end
	return Built
end

local function SendEvents(Rig: Rig, Events: any): Response
	return Rig.Call("POST", "/v1/telemetry/batch", { events = Events })
end

local function ExpectError(Response: Response, Status: number, Code: string)
	Expect(Response.Status).ToBe(Status)
	Expect(Response.Ok).ToBe(false)
	Expect(Response.Body.error).ToBe(Code)
end

-- A BackendClient on the mock with a fake clock, for the specs that need retries and deadlines.
local function Client(Rig: Rig, Policy: any?)
	local Clock = { Now = 0, Slept = 0 }
	local Made = BackendClient.new({
		BaseUrl = "http://mock",
		Transport = Rig.Transport,
		ApiKeyHeader = "ApiKey mock",
		Now = function()
			return Clock.Now
		end,
		Sleep = function(Seconds: number)
			Clock.Now += Seconds
			Clock.Slept += Seconds
		end,
		RandomUnit = function()
			return 0
		end,
		Retry = RetryPolicy,
		Policy = Policy or RetryPolicy.Default,
		Breakers = {
			Auth = CircuitBreaker.new(5, 30),
			Economy = CircuitBreaker.new(5, 30),
			Telemetry = CircuitBreaker.new(5, 30),
			Flags = CircuitBreaker.new(5, 30),
		},
		Budget = RateLimiter.new(100, 100),
	})
	return Made, Clock
end

Describe("MockTransport auth", function()
	It("trades an ApiKey for a token shaped like the backend's", function()
		local Rig = Make()
		local Response = Rig.Transport({
			Method = "POST",
			Url = "http://mock/auth/service-token",
			Headers = { Authorization = "ApiKey mock" },
			Body = {},
		})
		Expect(Response.Status).ToBe(200)
		Expect(type(Response.Body.accessToken)).ToBe("string")
		Expect(Response.Body.tokenType).ToBe("Bearer")
		Expect(Response.Body.expiresIn).ToBe(900)
		Expect(Response.Body.scope).ToBe("game:economy game:telemetry game:flags.read")
	end)

	It("a trade with no key, or a route with no token or a strange one, is a 401 with the challenge", function()
		local Rig = Make()
		ExpectError(
			Rig.Transport({ Method = "POST", Url = "http://mock/auth/service-token", Headers = {}, Body = {} }),
			401,
			"unauthorized"
		)
		local NoToken = Rig.Transport({ Method = "GET", Url = "http://mock/v1/flags", Headers = {} })
		ExpectError(NoToken, 401, "unauthorized")
		Expect(NoToken.Headers["www-authenticate"]).ToBe("Bearer")
		ExpectError(Rig.Call("GET", "/v1/flags", nil, { Authorization = "Bearer made-up" }), 401, "unauthorized")
		local WrongScheme = Rig.Transport({
			Method = "POST",
			Url = "http://mock/auth/service-token",
			Headers = { Authorization = "Bearer mock" },
			Body = {},
		})
		ExpectError(WrongScheme, 401, "unauthorized")
	end)

	It("ExpireTokens makes the next call a 401, and BackendClient trades again and carries on", function()
		local Rig = Make()
		local Made = Client(Rig)
		Expect(Made:Send(Requests.Flags()).Status).ToBe(200)
		Expect(Rig.Call("GET", "/v1/flags").Status).ToBe(200)
		Rig.Controls.ExpireTokens()
		ExpectError(Rig.Call("GET", "/v1/flags"), 401, "unauthorized")
		Expect(Made:Send(Requests.Flags()).Status).ToBe(200)
	end)
end)

Describe("MockTransport players", function()
	It("join makes an empty wallet, a rejoin keeps it, and leave answers 204 with no body", function()
		local Rig = Make()
		local Join = Rig.Call("POST", "/v1/players/1001/sessions", {})
		Expect(Join.Status).ToBe(200)
		Expect(Join.Body).ToEqual({ userId = 1001, balance = 0 })
		Earn(Rig, 1001, 40, "spec:earn:1")
		Expect(Rig.Call("POST", "/v1/players/1001/sessions", {}).Body.balance).ToBe(40)
		Expect(Rig.Call("GET", "/v1/players/1001/wallet").Body).ToEqual({ userId = 1001, balance = 40 })
		local Leave = Rig.Call("POST", "/v1/players/1001/sessions/end", {})
		Expect(Leave.Status).ToBe(204)
		Expect(Leave.Body).ToBeNil()
	end)

	It("a player who never joined is a 404 player_not_found", function()
		local Rig = Make()
		ExpectError(Rig.Call("GET", "/v1/players/1001/wallet"), 404, "player_not_found")
		ExpectError(Rig.Call("POST", "/v1/players/1001/sessions/end", {}), 404, "player_not_found")
		ExpectError(Earn(Rig, 1001, 5, "spec:earn:1"), 404, "player_not_found")
	end)

	It("a UserId in a path must be plain digits with no leading zero, the way the backend reads it", function()
		local Rig = Make()
		for _, Id in { "0", "007", "1e3", "-5", "1.5", "12345678901234567", "9007199254740993" } do
			ExpectError(Rig.Call("POST", `/v1/players/{Id}/sessions`, {}), 400, "invalid_request")
		end
		Expect(Rig.Call("POST", "/v1/players/9007199254740991/sessions", {}).Status).ToBe(200)
	end)

	It("an unknown route or method is a 404 not_found", function()
		local Rig = Make()
		ExpectError(Rig.Call("GET", "/v1/nothing"), 404, "not_found")
		ExpectError(Rig.Call("DELETE", "/v1/flags"), 404, "not_found")
	end)
end)

Describe("MockTransport earn", function()
	It("pays whole amounts from 1 to the 1000 cap and refuses the rest with a 400", function()
		local Rig = Joined(1001)
		Expect(Earn(Rig, 1001, 1, "spec:earn:a").Status).ToBe(201)
		Expect(Earn(Rig, 1001, 1000, "spec:earn:b").Status).ToBe(201)
		for Index, Amount in { 0, 1001, 1.5, -5, "5" } do
			ExpectError(Earn(Rig, 1001, Amount, `spec:earn:bad{Index}`), 400, "invalid_request")
		end
		Expect(Rig.Call("GET", "/v1/players/1001/wallet").Body.balance).ToBe(1001)
	end)

	It("a body with an unknown reason, a missing field or an extra field is a 400", function()
		local Rig = Joined(1001)
		ExpectError(Earn(Rig, 1001, 5, "spec:earn:r", { reason = "bonus" }), 400, "invalid_request")
		ExpectError(Earn(Rig, 1001, 5, "spec:earn:p", { price = 1 }), 400, "invalid_request")
		ExpectError(
			Rig.Call("POST", "/v1/economy/transactions", { kind = "earn", userId = 1001, amount = 5 }, {
				["Idempotency-Key"] = "spec:earn:m",
			}),
			400,
			"invalid_request"
		)
		ExpectError(
			Rig.Call("POST", "/v1/economy/transactions", { kind = "refund", userId = 1001 }, {
				["Idempotency-Key"] = "spec:earn:k",
			}),
			400,
			"invalid_request"
		)
		ExpectError(Earn(Rig, 0, 5, "spec:earn:u"), 400, "invalid_request")
	end)

	It("checks the Idempotency-Key the way the backend does, under any header case", function()
		local Rig = Joined(1001)
		for _, Key in { "short12", string.rep("k", 129), "has space", "semi;colon" } do
			ExpectError(Earn(Rig, 1001, 5, Key), 400, "invalid_request")
		end
		ExpectError(
			Rig.Call("POST", "/v1/economy/transactions", { kind = "earn", userId = 1001, amount = 5, reason = "orbs" }),
			400,
			"invalid_request"
		)
		Expect(Earn(Rig, 1001, 5, "Ab:_-123").Status).ToBe(201)
		Expect(Earn(Rig, 1001, 5, string.rep("k", 128)).Status).ToBe(201)
		local Lower = Rig.Call(
			"POST",
			"/v1/economy/transactions",
			{ kind = "earn", userId = 1001, amount = 5, reason = "orbs" },
			{ ["idempotency-key"] = "spec:lower:1" }
		)
		Expect(Lower.Status).ToBe(201)
	end)

	It("a replay answers 200 with the first result, the replay header, and pays nothing", function()
		local Rig = Joined(1001)
		local First = Earn(Rig, 1001, 30, "spec:earn:once")
		local Again = Earn(Rig, 1001, 30, "spec:earn:once")
		Expect(First.Status).ToBe(201)
		Expect(First.Body.replayed).ToBe(false)
		Expect(First.Headers["idempotent-replayed"]).ToBeNil()
		Expect(Again.Status).ToBe(200)
		Expect(Again.Headers["idempotent-replayed"]).ToBe("true")
		local Expected = table.clone(First.Body)
		Expected.replayed = true
		-- Whatever the caller does to the first body must not leak into the stored result.
		First.Body.amount = 999
		Again = Earn(Rig, 1001, 30, "spec:earn:once")
		Expect(Again.Body).ToEqual(Expected)
		Again.Body.amount = 777
		Expect(Earn(Rig, 1001, 30, "spec:earn:once").Body).ToEqual(Expected)
		Expect(Rig.Call("GET", "/v1/players/1001/wallet").Body.balance).ToBe(30)
	end)

	It("keys are case sensitive, so two keys that differ only in case are two transactions", function()
		local Rig = Joined(1001)
		Expect(Earn(Rig, 1001, 5, "spec:case:a").Status).ToBe(201)
		Expect(Earn(Rig, 1001, 5, "SPEC:CASE:A").Status).ToBe(201)
		Expect(Rig.Call("GET", "/v1/players/1001/wallet").Body.balance).ToBe(10)
	end)

	It("the same key with any other body is a 409 idempotency_key_reuse", function()
		local Rig = Joined(1001, 100)
		Earn(Rig, 1001, 30, "spec:earn:k")
		ExpectError(Earn(Rig, 1001, 31, "spec:earn:k"), 409, "idempotency_key_reuse")
		ExpectError(Buy(Rig, 1001, "RedHat", "spec:earn:k"), 409, "idempotency_key_reuse")
		Rig.Call("POST", "/v1/players/2002/sessions", {})
		ExpectError(Earn(Rig, 2002, 30, "spec:earn:k"), 409, "idempotency_key_reuse")
	end)
end)

Describe("MockTransport purchases", function()
	It("charges the Configs/Shop price and answers the backend's result shape", function()
		local Rig = Joined(1001, 100)
		local Response = Buy(Rig, 1001, "RedHat", HatKey)
		Expect(Response.Status).ToBe(201)
		local Body = Response.Body
		Expect(Body.kind).ToBe("purchase")
		Expect(Body.userId).ToBe(1001)
		Expect(Body.amount).ToBe(-Shop.RedHat.Price)
		Expect(Body.balanceAfter).ToBe(100 - Shop.RedHat.Price)
		Expect(Body.itemId).ToBe("RedHat")
		Expect(Body.createdAt).ToBe("2027-01-15T08:00:00.000Z")
		Expect(Body.replayed).ToBe(false)
		Expect(Requests.Fulfilled(Body.transactionId).Method).ToBe("POST")
	end)

	It("an item outside the catalog or a body with a price in it is a 400", function()
		local Rig = Joined(1001, 100)
		ExpectError(Buy(Rig, 1001, "Sword", "spec:buy:sword"), 400, "invalid_request")
		ExpectError(
			Rig.Call(
				"POST",
				"/v1/economy/transactions",
				{ kind = "purchase", userId = 1001, itemId = "RedHat", price = 0 },
				{
					["Idempotency-Key"] = "spec:buy:cheap",
				}
			),
			400,
			"invalid_request"
		)
	end)

	It("insufficient funds is a 422 that does not use up the key", function()
		local Rig = Joined(1001, 10)
		ExpectError(Buy(Rig, 1001, "RedHat", HatKey), 422, "insufficient_funds")
		Expect(Rig.Call("GET", "/v1/players/1001/wallet").Body.balance).ToBe(10)
		Earn(Rig, 1001, 20, "spec:earn:more")
		Expect(Buy(Rig, 1001, "RedHat", HatKey).Status).ToBe(201)
		Expect(Rig.Call("GET", "/v1/players/1001/wallet").Body.balance).ToBe(5)
	end)

	It("a lost answer then a retry with the same key charges once", function()
		local Rig = Joined(1001, 60)
		local Made = Client(Rig, { MaxAttempts = 1, BaseDelay = 0.5, MaxDelay = 4 })
		Rig.Controls.LoseNextAnswer()
		local First = PurchaseFlow.Submit(Made, Requests, 1001, "RedHat", HatKey)
		Expect(First.Action).ToBe("RetryLater")
		local Second, Response = PurchaseFlow.Submit(Made, Requests, 1001, "RedHat", HatKey)
		Expect(Second.Action).ToBe("Grant")
		Expect(Response.Status).ToBe(200)
		Expect(Second.BalanceAfter).ToBe(35)
		Expect(Rig.Call("GET", "/v1/players/1001/wallet").Body.balance).ToBe(35)
		Expect(#Rig.Call("GET", "/v1/players/1001/purchases?unfulfilled=1").Body.purchases).ToBe(1)
	end)

	It("BackendClient retries a lost answer with the same key on its own and still charges once", function()
		local Rig = Joined(1001, 60)
		local Made = Client(Rig)
		Rig.Controls.LoseNextAnswer()
		local Decision, Response = PurchaseFlow.Submit(Made, Requests, 1001, "RedHat", HatKey)
		Expect(Decision.Action).ToBe("Grant")
		Expect(Response.Headers["idempotent-replayed"]).ToBe("true")
		Expect(Rig.Call("GET", "/v1/players/1001/wallet").Body.balance).ToBe(35)
	end)
end)

Describe("MockTransport acknowledgements", function()
	It("an unacknowledged purchase is listed until it is acknowledged, which is safe to repeat", function()
		local Rig = Joined(1001, 200)
		local Hat = Buy(Rig, 1001, "RedHat", "spec:buy:1").Body
		local Crown = Buy(Rig, 1001, "GoldCrown", "spec:buy:2").Body
		local Listed = Rig.Call("GET", "/v1/players/1001/purchases?unfulfilled=1")
		Expect(Listed.Status).ToBe(200)
		Expect(Listed.Body).ToEqual({
			purchases = {
				{ transactionId = Hat.transactionId, itemId = "RedHat", createdAt = Hat.createdAt },
				{ transactionId = Crown.transactionId, itemId = "GoldCrown", createdAt = Crown.createdAt },
			},
		})
		local Ack = Rig.Call("POST", `/v1/economy/transactions/{Hat.transactionId}/fulfilled`, {})
		Expect(Ack.Status).ToBe(204)
		Expect(Ack.Body).ToBeNil()
		Expect(Rig.Call("POST", `/v1/economy/transactions/{Hat.transactionId}/fulfilled`, {}).Status).ToBe(204)
		local After = Rig.Call("GET", "/v1/players/1001/purchases?unfulfilled=1").Body.purchases
		Expect(#After).ToBe(1)
		Expect(After[1].itemId).ToBe("GoldCrown")
		Expect(#Rig.Call("GET", "/v1/players/2002/purchases?unfulfilled=1").Body.purchases).ToBe(0)
	end)

	It("a well formed id that is not a purchase is a 404 purchase_not_found", function()
		local Rig = Joined(1001)
		local EarnId = Earn(Rig, 1001, 5, "spec:earn:ack").Body.transactionId
		ExpectError(Rig.Call("POST", `/v1/economy/transactions/{EarnId}/fulfilled`, {}), 404, "purchase_not_found")
		ExpectError(Rig.Call("POST", `/v1/economy/transactions/{Uuid}/fulfilled`, {}), 404, "purchase_not_found")
	end)

	It("an id that is not a uuid is a 400, and the mock agrees with Requests on every id", function()
		local Rig = Joined(1001)
		local Ids = {
			"----",
			"t-1",
			Uuid,
			"00000000-0000-0000-0000-000000000000",
			"ffffffff-ffff-ffff-ffff-ffffffffffff",
			"FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
			"00000000-0000-9000-8000-000000000000",
			"00000000-0000-4000-c000-000000000000",
			"00000000-0000-4000-B000-00000000000A",
			"00000000-0000-4000-8000-0000000000000",
			"g0000000-0000-4000-8000-000000000000",
		}
		for _, Id in Ids do
			local Built = pcall(Requests.Fulfilled, Id)
			local Status = Rig.Call("POST", `/v1/economy/transactions/{Id}/fulfilled`, {}).Status
			Expect(MockTransport.IsTransactionId(Id)).ToBe(Built)
			Expect(Status).ToBe(if Built then 404 else 400)
		end
	end)

	It("the purchases list needs exactly unfulfilled=1", function()
		local Rig = Joined(1001)
		for _, Query in { "", "?unfulfilled=0", "?unfulfilled=1&x=2", "?all=1" } do
			ExpectError(Rig.Call("GET", `/v1/players/1001/purchases{Query}`), 400, "invalid_request")
		end
	end)
end)

Describe("MockTransport telemetry", function()
	It("accepts a clean batch with every dims key", function()
		local Rig = Make()
		local Response = SendEvents(Rig, {
			Event(),
			Event({ name = "purchase_result", dims = { outcome = "Granted", itemId = "RedHat" }, value = -5 }),
			Event({ name = "breaker_state", dims = { state = "Open" } }),
			Event({ name = "netguard_drop", dims = { packet = "Unknown", reason = "Throttled" } }),
		})
		Expect(Response.Status).ToBe(202)
		Expect(Response.Body).ToEqual({ accepted = 4, dropped = 0 })
	end)

	It("refuses the whole batch with a 400 when any event breaks the schema", function()
		local Rig = Make()
		local Bad = {
			Event({ name = "made_up" }),
			Event({ dims = { outcome = "other" } }),
			Event({ dims = { packet = "Hacked.Name" } }),
			Event({ dims = { bogus = "Closed" } }),
			Event({ dims = { itemId = "Sword" } }),
			Event({ dims = { state = 5 } }),
			Event({ dims = "Open" }),
			Event({ extra = 1 }),
			Event({ ts = 1.5 }),
			Event({ ts = 0 }),
			Event({ ts = "now" }),
			Event({ userId = 0 }),
			Event({ userId = 1.5 }),
			Event({ value = 2e9 }),
			Event({ value = "1" }),
			5,
		}
		local Mixed: { [any]: any } = { Event() }
		Mixed.extra = Event()
		ExpectError(SendEvents(Rig, Mixed), 400, "invalid_request")
		for _, Broken in Bad do
			ExpectError(SendEvents(Rig, { Event(), Broken }), 400, "invalid_request")
		end
	end)

	It("needs 1 to 500 events and nothing else in the body", function()
		local Rig = Make()
		ExpectError(SendEvents(Rig, {}), 400, "invalid_request")
		ExpectError(SendEvents(Rig, "events"), 400, "invalid_request")
		local Many = table.create(501, Event())
		ExpectError(SendEvents(Rig, Many), 400, "invalid_request")
		Expect(SendEvents(Rig, table.create(500, Event())).Body.accepted).ToBe(500)
		ExpectError(
			Rig.Call("POST", "/v1/telemetry/batch", { events = { Event() }, extra = true }),
			400,
			"invalid_request"
		)
	end)

	It("drops events more than 5 minutes ahead or more than a day old and counts them", function()
		local Rig = Make()
		local Minute = 60000
		local Response = SendEvents(Rig, {
			Event({ ts = NowMs + 5 * Minute }),
			Event({ ts = NowMs + 5 * Minute + 1 }),
			Event({ ts = NowMs - 24 * 60 * Minute }),
			Event({ ts = NowMs - 24 * 60 * Minute - 1 }),
			Event({ ts = 1800000000 }),
		})
		Expect(Response.Status).ToBe(202)
		Expect(Response.Body).ToEqual({ accepted = 2, dropped = 3 })
	end)

	It("TelemetryEnabled false accepts nothing but still checks the batch", function()
		local Off = table.clone(Flags) :: any
		Off.TelemetryEnabled = false
		local Rig = Make(Off)
		local Response = SendEvents(Rig, { Event(), Event() })
		Expect(Response.Status).ToBe(202)
		Expect(Response.Body).ToEqual({ accepted = 0, dropped = 2 })
		ExpectError(SendEvents(Rig, { Event({ name = "made_up" }) }), 400, "invalid_request")
		Rig.Controls.SetFlag("TelemetryEnabled", true)
		Expect(SendEvents(Rig, { Event() }).Body.accepted).ToBe(1)
	end)
end)

Describe("MockTransport flags and faults", function()
	It("serves the flags it was given, and SetFlag changes them", function()
		local Rig = Make()
		local Response = Rig.Call("GET", "/v1/flags")
		Expect(Response.Status).ToBe(200)
		Expect(Response.Body.flags).ToEqual(table.clone(Flags))
		Response.Body.flags.ShopEnabled = "changed by a caller"
		Expect(Rig.Call("GET", "/v1/flags").Body.flags.ShopEnabled).ToBe(true)
		Rig.Controls.SetFlag("ShopEnabled", false)
		Expect(Rig.Call("GET", "/v1/flags").Body.flags.ShopEnabled).ToBe(false)
		Expect(Flags.ShopEnabled).ToBe(true)
	end)

	It("FailNext answers a 503 flags_unavailable with Retry-After, and FlagValues keeps the last values", function()
		local Rig = Make()
		Rig.Controls.FailNext(503, "flags_unavailable", 1)
		local Response = Rig.Call("GET", "/v1/flags")
		ExpectError(Response, 503, "flags_unavailable")
		Expect(Response.Headers["retry-after"]).ToBe("1")
		local Current = { ShopEnabled = false, OrbSpawnMultiplier = 2, TelemetryEnabled = true }
		Expect(FlagValues.FromResponse(Flags, Current, Response)).ToEqual(Current)
		Expect(Rig.Call("GET", "/v1/flags").Status).ToBe(200)
	end)

	It("FailNext can fail several calls, and a 429 with no Retry-After sends no header", function()
		local Rig = Make()
		Rig.Controls.FailNext(429, "rate_limited", nil, 2)
		ExpectError(Rig.Call("GET", "/v1/flags"), 429, "rate_limited")
		local Second = Rig.Call("GET", "/v1/flags")
		ExpectError(Second, 429, "rate_limited")
		Expect(Second.Headers["retry-after"]).ToBeNil()
		Expect(Rig.Call("GET", "/v1/flags").Status).ToBe(200)
	end)

	It("BackendClient waits out a 429 Retry-After from the mock and then gets through", function()
		local Rig = Make()
		local Made, Clock = Client(Rig)
		Made:Send(Requests.Flags())
		Rig.Controls.FailNext(429, "rate_limited", 7)
		Expect(Made:Send(Requests.Flags()).Status).ToBe(200)
		Expect(Clock.Slept >= 7).ToBe(true)
	end)

	It("a purchase that meets a long Retry-After gives RetryLater inside its short deadline", function()
		local Rig = Joined(1001, 60)
		local Made, Clock = Client(Rig)
		Made:Send(Requests.Flags())
		Rig.Controls.FailNext(503, "ledger_unavailable", 30)
		Expect(PurchaseFlow.Submit(Made, Requests, 1001, "RedHat", HatKey).Action).ToBe("RetryLater")
		Expect(Clock.Slept).ToBe(0)
		Expect(Rig.Call("GET", "/v1/players/1001/wallet").Body.balance).ToBe(60)
	end)

	It("a fault never lands on the token trade", function()
		local Rig = Make()
		local Made = Client(Rig, { MaxAttempts = 1, BaseDelay = 0.5, MaxDelay = 4 })
		Rig.Controls.FailNext(503, "ledger_unavailable", nil, 1)
		Expect(Made:Send(Requests.Flags()).Status).ToBe(503)
		Expect(Made:Send(Requests.Flags()).Status).ToBe(200)
	end)
end)

Describe("MockTransport drift", function()
	It("the earn cap and reasons match plan.ts", function()
		local Plan = Fs.readFile("../backend/src/modules/economy/plan.ts")
		Expect(tonumber(string.match(Plan, "MAX_EARN_PER_TRANSACTION = (%d+)"))).ToBe(MockTransport.MaxEarn)
		local Reasons = string.match(Plan, "EARN_REASONS = %[([^%]]*)%]")
		assert(Reasons ~= nil, "EARN_REASONS is missing from plan.ts")
		local Found = {}
		for Reason in string.gmatch(Reasons, "'([^']+)'") do
			table.insert(Found, Reason)
		end
		Expect(Found).ToEqual(MockTransport.EarnReasons)
	end)

	It("the clock skew limits match schema.ts", function()
		local Schema = Fs.readFile("../backend/src/modules/telemetry/schema.ts")
		Expect(string.match(Schema, "MAX_FUTURE_SKEW_MS = ([^;]+);")).ToBe("5 * 60_000")
		Expect(string.match(Schema, "MAX_EVENT_AGE_MS = ([^;]+);")).ToBe("24 * 60 * 60_000")
		Expect(MockTransport.MaxFutureSkewMs).ToBe(5 * 60000)
		Expect(MockTransport.MaxEventAgeMs).ToBe(24 * 60 * 60000)
	end)
end)

return nil
