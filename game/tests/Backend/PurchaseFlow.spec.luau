--!strict
local Harness = require("@Tests/Harness")
local PurchaseFlow = require("@Logic/Backend/PurchaseFlow")
local Requests = require("@Logic/Backend/Requests")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

local function Reply(Status: number, Body: any?)
	return { Ok = Status >= 200 and Status < 300, Status = Status, Body = Body, Headers = {} }
end

local Known = { RedHat = "RedHat", GoldCrown = "GoldCrown" }
local Granted = { transactionId = "00000000-0000-4000-8000-000000000001", balanceAfter = 5 }

-- A stand in for BackendClient that answers from a list and remembers what it was asked.
local function FakeClient(Answers: { any })
	local Sent: { { Request: any, Options: any } } = {}
	local Client = {}
	function Client.Send(_self: any, Request: any, Options: any)
		table.insert(Sent, { Request = Request, Options = Options })
		return Answers[#Sent] or Reply(0)
	end
	return Client, Sent
end

Describe("PurchaseFlow.Decide", function()
	It("a 201 or a replayed 200 with a transaction grants", function()
		Expect(PurchaseFlow.Decide(Reply(201, Granted))).ToEqual({
			Action = "Grant",
			Outcome = "Granted",
			TransactionId = Granted.transactionId,
			BalanceAfter = 5,
		})
		Expect(PurchaseFlow.Decide(Reply(200, Granted)).Action).ToBe("Grant")
	end)

	It("insufficient funds is a definite TooPoor", function()
		Expect(PurchaseFlow.Decide(Reply(422, { error = "insufficient_funds" }))).ToEqual({
			Action = "Refuse",
			Outcome = "TooPoor",
		})
	end)

	It("no answer, a local refusal, a throttle or a server error means retry later", function()
		for _, Status in { 0, -1, -2, -3, 404, 408, 425, 429, 500, 503 } do
			Expect(PurchaseFlow.Decide(Reply(Status))).ToEqual({ Action = "RetryLater", Outcome = "Unavailable" })
		end
	end)

	It("a success with a garbled body cannot be trusted either way", function()
		Expect(PurchaseFlow.Decide(Reply(201, "oops")).Action).ToBe("RetryLater")
		Expect(PurchaseFlow.Decide(Reply(201, { transactionId = 5, balanceAfter = 5 })).Action).ToBe("RetryLater")
		Expect(PurchaseFlow.Decide(Reply(201, { transactionId = "t-1" })).Action).ToBe("RetryLater")
		Expect(PurchaseFlow.Decide(Reply(201, { transactionId = "t-1", balanceAfter = 0 / 0 })).Action).ToBe(
			"RetryLater"
		)
	end)

	It("only 200 and 201 can grant, any other status outside 4xx is unclear", function()
		for _, Status in { 199, 202, 204, 300, 302 } do
			Expect(PurchaseFlow.Decide(Reply(Status, Granted)).Action).ToBe("RetryLater")
		end
	end)

	It("any other client error is a plain refusal", function()
		for _, Status in { 400, 401, 403, 409, 413, 418, 499 } do
			Expect(PurchaseFlow.Decide(Reply(Status, { error = "idempotency_key_reuse" }))).ToEqual({
				Action = "Refuse",
				Outcome = "Unavailable",
			})
		end
		Expect(PurchaseFlow.Decide(Reply(422, { error = "invalid_request" })).Outcome).ToBe("Unavailable")
		Expect(PurchaseFlow.Decide(Reply(422, nil)).Outcome).ToBe("Unavailable")
	end)

	It("every outcome is one the backend's telemetry allows", function()
		local Allowed = { Granted = true, TooPoor = true, Unavailable = true }
		for _, Status in { 0, 201, 400, 422, 503 } do
			local Body = if Status == 422 then { error = "insufficient_funds" } else Granted
			Expect(Allowed[PurchaseFlow.Decide(Reply(Status, Body)).Outcome]).ToBe(true)
		end
	end)
end)

Describe("PurchaseFlow.Submit", function()
	It("sends the caller's key with a short deadline and decides the answer", function()
		local Client, Sent = FakeClient({ Reply(201, Granted) })
		local Decision, Response = PurchaseFlow.Submit(Client, Requests, 1001, "RedHat", "boot-0badf00d:buy:1")
		Expect(Decision.Action).ToBe("Grant")
		Expect(Response.Status).ToBe(201)
		Expect(#Sent).ToBe(1)
		Expect(Sent[1].Request.Headers["Idempotency-Key"]).ToBe("boot-0badf00d:buy:1")
		Expect(Sent[1].Request.Body.itemId).ToBe("RedHat")
		Expect(Sent[1].Request.Body.userId).ToBe(1001)
		Expect(Sent[1].Options.DeadlineSeconds).ToBe(PurchaseFlow.DeadlineSeconds)
		Expect(PurchaseFlow.DeadlineSeconds).ToBe(10)
	end)

	It("a retry after RetryLater sends the very same key", function()
		local Client, Sent = FakeClient({ Reply(-3), Reply(200, Granted) })
		local Key = "boot-0badf00d:buy:7"
		Expect(PurchaseFlow.Submit(Client, Requests, 1001, "RedHat", Key).Action).ToBe("RetryLater")
		Expect(PurchaseFlow.Submit(Client, Requests, 1001, "RedHat", Key).Action).ToBe("Grant")
		Expect(Sent[1].Request.Headers["Idempotency-Key"]).ToBe(Key)
		Expect(Sent[2].Request.Headers["Idempotency-Key"]).ToBe(Key)
	end)

	It("a key the backend would refuse throws before anything is sent", function()
		local Client, Sent = FakeClient({})
		Expect(function()
			PurchaseFlow.Submit(Client, Requests, 1001, "RedHat", "short")
		end).ToThrow("idempotency key")
		Expect(#Sent).ToBe(0)
	end)
end)

Describe("PurchaseFlow.ReconcilePlan", function()
	It("grants what the player lacks and acknowledges every known purchase once", function()
		local Plan = PurchaseFlow.ReconcilePlan({
			{ transactionId = "t-1", itemId = "RedHat" },
			{ transactionId = "t-2", itemId = "RedHat" },
			{ transactionId = "t-3", itemId = "GoldCrown" },
			{ transactionId = "t-1", itemId = "RedHat" },
		}, { GoldCrown = true }, Known)
		Expect(Plan).ToEqual({ Grant = { "RedHat" }, Ack = { "t-1", "t-2", "t-3" } })
	end)

	It("leaves an unknown item alone so an operator can see it", function()
		Expect(PurchaseFlow.ReconcilePlan({ { transactionId = "t-9", itemId = "Sword" } }, {}, Known)).ToEqual({
			Grant = {},
			Ack = {},
		})
		-- An inherited name is not an item either.
		Expect(PurchaseFlow.ReconcilePlan({ { transactionId = "t-9", itemId = "__index" } }, {}, Known)).ToEqual({
			Grant = {},
			Ack = {},
		})
	end)

	It("garbage input gives an empty plan instead of an error", function()
		Expect(PurchaseFlow.ReconcilePlan(nil, {}, Known)).ToEqual({ Grant = {}, Ack = {} })
		Expect(PurchaseFlow.ReconcilePlan("purchases", {}, Known)).ToEqual({ Grant = {}, Ack = {} })
		Expect(PurchaseFlow.ReconcilePlan({ 5, { itemId = "RedHat" } }, {}, Known)).ToEqual({ Grant = {}, Ack = {} })
		Expect(PurchaseFlow.ReconcilePlan({ { transactionId = 7, itemId = "RedHat" } }, {}, Known)).ToEqual({
			Grant = {},
			Ack = {},
		})
	end)
end)

return nil
