--!strict
-- The backend contract, written once and run twice. Backend/MockContract.spec runs it against
-- MockTransport in every unit run, and the contract job in CI runs it against a real backend.
-- If MockTransport ever drifts from the backend, one of the two runs fails.
-- It checks the refusals as well as the happy path, so the mock has to say no where the backend does.
-- The steps share state and run in order, like one player's visit.
-- The backend must be fresh for UserId, so the first join finds an empty wallet, and UserId plus 1
-- must never have joined. UserId plus 2 must be fresh too. It is a second player who buys something,
-- so a purchase list that is not kept per player fails. KeyPrefix must be new for every run against
-- the same database.
local Harness = require("@Tests/Harness")
local PurchaseFlow = require("@Logic/Backend/PurchaseFlow")
local Requests = require("@Logic/Backend/Requests")
local Flags = require("@Configs/Flags")
local Shop = require("@Configs/Shop")
local Telemetry = require("@Configs/Telemetry")

local Suite = {}

-- A uuid the backend will never have handed out, since it only makes random version 4 ids.
local UnknownTransactionId = "00000000-0000-1000-8000-000000000000"

local function NowMillis(): number
	return os.time() * 1000
end

function Suite.Run(Label: string, Client: any, UserId: number, KeyPrefix: string)
	local Describe = Harness.Describe
	local It = Harness.It
	local Expect = Harness.Expect
	local HatPrice = Shop.RedHat.Price
	local EarnAmount = HatPrice + 5
	local EarnKey = `{KeyPrefix}:earn:1`
	local HatKey = `{KeyPrefix}:buy:hat`
	local StrangerId = UserId + 1
	local OtherId = UserId + 2
	local FirstEarnId: string? = nil
	local FirstEarnBody: any = nil
	local HatTransactionId: string? = nil
	local HatBody: any = nil

	local function ExpectError(Response: any, Status: number, Code: string)
		Expect(Response.Status).ToBe(Status)
		Expect(type(Response.Body) == "table" and Response.Body.error or nil).ToBe(Code)
	end

	-- What a replay must answer, the first result exactly with only replayed flipped to true.
	local function AsReplay(First: any): any
		local Copy = table.clone(First)
		Copy.replayed = true
		return Copy
	end

	local function Balance(): number
		return Client:Send(Requests.Wallet(UserId)).Body.balance
	end

	local function Event(Fields: { [string]: any }?): { [string]: any }
		local Built: { [string]: any } = { name = "player_join", ts = NowMillis(), userId = UserId }
		local Extra: { [string]: any } = Fields or {}
		for Field, Value in Extra do
			Built[Field] = Value
		end
		return Built
	end

	-- Builds a call by hand, for the refusals that Requests would never build.
	local function Raw(Method: string, Path: string, Body: any?, Headers: { [string]: string }?)
		return Client:Send({ Method = Method, Path = Path, Body = Body, Headers = Headers })
	end

	Describe(`backend contract ({Label})`, function()
		It("join creates the player with an empty wallet", function()
			local Response = Client:Send(Requests.JoinSession(UserId))
			Expect(Response.Status).ToBe(200)
			Expect(Response.Body.userId).ToBe(UserId)
			Expect(Response.Body.balance).ToBe(0)
		end)

		It("an earn batch pays its Coins once", function()
			local Response = Client:Send(Requests.Earn(UserId, EarnAmount, EarnKey))
			Expect(Response.Status).ToBe(201)
			Expect(Response.Body.amount).ToBe(EarnAmount)
			Expect(Response.Body.balanceAfter).ToBe(EarnAmount)
			Expect(Response.Body.replayed).ToBe(false)
			FirstEarnId = Response.Body.transactionId
			FirstEarnBody = Response.Body
		end)

		It("replaying the same key returns the first result and pays nothing", function()
			local Response = Client:Send(Requests.Earn(UserId, EarnAmount, EarnKey))
			Expect(Response.Status).ToBe(200)
			Expect(Response.Headers["idempotent-replayed"]).ToBe("true")
			Expect(Response.Body.replayed).ToBe(true)
			Expect(Response.Body.transactionId).ToBe(FirstEarnId)
			Expect(Response.Body).ToEqual(AsReplay(FirstEarnBody))
			Expect(Balance()).ToBe(EarnAmount)
		end)

		It("the same key with a different amount is refused", function()
			ExpectError(Client:Send(Requests.Earn(UserId, EarnAmount + 1, EarnKey)), 409, "idempotency_key_reuse")
		end)

		It("an earn over the 1000 cap is refused", function()
			ExpectError(Client:Send(Requests.Earn(UserId, 1001, `{KeyPrefix}:earn:big`)), 400, "invalid_request")
			Expect(Balance()).ToBe(EarnAmount)
		end)

		It("a key the backend's rule refuses is a 400", function()
			local Body = { kind = "earn", userId = UserId, amount = 5, reason = "orbs" }
			ExpectError(
				Raw("POST", "/v1/economy/transactions", Body, { ["Idempotency-Key"] = "short12" }),
				400,
				"invalid_request"
			)
			ExpectError(
				Raw("POST", "/v1/economy/transactions", Body, { ["Idempotency-Key"] = "has a space" }),
				400,
				"invalid_request"
			)
			Expect(Balance()).ToBe(EarnAmount)
		end)

		It("an earn for a player who never joined is a 404", function()
			ExpectError(Client:Send(Requests.Earn(StrangerId, 5, `{KeyPrefix}:earn:stranger`)), 404, "player_not_found")
		end)

		It("a purchase charges the price in Configs/Shop", function()
			local Decision, Response = PurchaseFlow.Submit(Client, Requests, UserId, "RedHat", HatKey)
			Expect(Response.Status).ToBe(201)
			Expect(Decision.Action).ToBe("Grant")
			Expect(Response.Body.amount).ToBe(-HatPrice)
			Expect(Response.Body.itemId).ToBe("RedHat")
			Expect(Decision.BalanceAfter).ToBe(EarnAmount - HatPrice)
			HatTransactionId = Decision.TransactionId
			HatBody = Response.Body
		end)

		It("a purchase retried with the same key replays and charges once", function()
			local Decision, Response = PurchaseFlow.Submit(Client, Requests, UserId, "RedHat", HatKey)
			Expect(Response.Status).ToBe(200)
			Expect(Decision.Action).ToBe("Grant")
			Expect(Decision.TransactionId).ToBe(HatTransactionId)
			Expect(Response.Body).ToEqual(AsReplay(HatBody))
			Expect(Balance()).ToBe(EarnAmount - HatPrice)
		end)

		It("a body with a price in it is refused, the backend is the only price authority", function()
			ExpectError(
				Raw(
					"POST",
					"/v1/economy/transactions",
					{ kind = "purchase", userId = UserId, itemId = "GoldCrown", price = 0 },
					{ ["Idempotency-Key"] = `{KeyPrefix}:buy:cheap` }
				),
				400,
				"invalid_request"
			)
		end)

		It("a purchase the player cannot afford comes back TooPoor and takes nothing", function()
			local Decision, Response =
				PurchaseFlow.Submit(Client, Requests, UserId, "GoldCrown", `{KeyPrefix}:buy:crown`)
			ExpectError(Response, 422, "insufficient_funds")
			Expect(Decision).ToEqual({ Action = "Refuse", Outcome = "TooPoor" })
			Expect(Balance()).ToBe(EarnAmount - HatPrice)
		end)

		It("an unacknowledged purchase shows up for reconcile until it is fulfilled", function()
			-- A second player buys too, and their purchase must stay out of this player's list.
			Expect(Client:Send(Requests.JoinSession(OtherId)).Status).ToBe(200)
			Expect(Client:Send(Requests.Earn(OtherId, HatPrice, `{KeyPrefix}:earn:other`)).Status).ToBe(201)
			local OtherBuy = PurchaseFlow.Submit(Client, Requests, OtherId, "RedHat", `{KeyPrefix}:buy:other`)
			Expect(OtherBuy.Action).ToBe("Grant")
			local Pending = Client:Send(Requests.Unfulfilled(UserId))
			Expect(Pending.Status).ToBe(200)
			Expect(#Pending.Body.purchases).ToBe(1)
			Expect(Pending.Body.purchases[1].transactionId).ToBe(HatTransactionId)
			Expect(Pending.Body.purchases[1].itemId).ToBe("RedHat")
			local Plan = PurchaseFlow.ReconcilePlan(Pending.Body.purchases, {}, { RedHat = "RedHat" })
			Expect(Plan).ToEqual({ Grant = { "RedHat" }, Ack = { HatTransactionId :: string } })
			Expect(Client:Send(Requests.Fulfilled(HatTransactionId :: string)).Status).ToBe(204)
			Expect(Client:Send(Requests.Fulfilled(HatTransactionId :: string)).Status).ToBe(204)
			Expect(#Client:Send(Requests.Unfulfilled(UserId)).Body.purchases).ToBe(0)
			local Others = Client:Send(Requests.Unfulfilled(OtherId)).Body.purchases
			Expect(#Others).ToBe(1)
			Expect(Others[1].transactionId).ToBe(OtherBuy.TransactionId)
			Expect(Client:Send(Requests.Fulfilled(OtherBuy.TransactionId :: string)).Status).ToBe(204)
			Expect(Client:Send(Requests.LeaveSession(OtherId)).Status).ToBe(204)
		end)

		It("acknowledging an id that is not a uuid is a 400, and an unknown one a 404", function()
			ExpectError(Raw("POST", "/v1/economy/transactions/----/fulfilled", {}), 400, "invalid_request")
			ExpectError(Client:Send(Requests.Fulfilled(UnknownTransactionId)), 404, "purchase_not_found")
			ExpectError(Client:Send(Requests.Fulfilled(FirstEarnId :: string)), 404, "purchase_not_found")
		end)

		It("after a 1000 earn GoldCrown costs its Configs/Shop price, on the key the 422 left unused", function()
			local Before = Balance()
			Expect(Client:Send(Requests.Earn(UserId, 1000, `{KeyPrefix}:earn:2`)).Status).ToBe(201)
			local Decision, Response =
				PurchaseFlow.Submit(Client, Requests, UserId, "GoldCrown", `{KeyPrefix}:buy:crown`)
			Expect(Response.Status).ToBe(201)
			Expect(Decision.Action).ToBe("Grant")
			Expect(Response.Body.amount).ToBe(-Shop.GoldCrown.Price)
			Expect(Decision.BalanceAfter).ToBe(Before + 1000 - Shop.GoldCrown.Price)
			Expect(Balance()).ToBe(Before + 1000 - Shop.GoldCrown.Price)
			Expect(Client:Send(Requests.Fulfilled(Decision.TransactionId :: string)).Status).ToBe(204)
		end)

		It("telemetry takes every event name and every dims value in Configs/Telemetry", function()
			local Events = {}
			for _, Name in Telemetry.EventNames do
				table.insert(Events, Event({ name = Name }))
			end
			for Key, Values in Telemetry.DimValues do
				for _, Value in Values do
					table.insert(Events, Event({ name = "purchase_result", value = 1, dims = { [Key] = Value } }))
				end
			end
			local Response = Client:Send(Requests.TelemetryBatch(Events))
			Expect(Response.Status).ToBe(202)
			Expect(Response.Body.accepted).ToBe(#Events)
			Expect(Response.Body.dropped).ToBe(0)
		end)

		It("telemetry drops an event from more than a day ago and counts it", function()
			local Response = Client:Send(Requests.TelemetryBatch({
				Event(),
				Event({ ts = NowMillis() - 25 * 60 * 60 * 1000 }),
			}))
			Expect(Response.Status).ToBe(202)
			Expect(Response.Body.accepted).ToBe(1)
			Expect(Response.Body.dropped).ToBe(1)
		end)

		It("one event outside the allow lists refuses the whole batch", function()
			local Broken = {
				Event({ name = "made_up" }),
				Event({ dims = { outcome = "other" } }),
				Event({ dims = { packet = "Hacked.Name" } }),
				Event({ dims = { bogus = "Closed" } }),
				Event({ extra = 1 }),
			}
			for _, Bad in Broken do
				ExpectError(Client:Send(Requests.TelemetryBatch({ Event(), Bad })), 400, "invalid_request")
			end
		end)

		It("the flag defaults match Configs/Flags", function()
			local Response = Client:Send(Requests.Flags())
			Expect(Response.Status).ToBe(200)
			for Key, Default in pairs(Flags :: any) do
				Expect(Response.Body.flags[Key]).ToBe(Default)
			end
		end)

		It("leaving ends the session", function()
			local Response = Client:Send(Requests.LeaveSession(UserId))
			Expect(Response.Status).ToBe(204)
			-- BackendClient drops any body on a 204 by itself, so this nil is the client's doing and not
			-- the server's. The raw answer is only checked by the T31 transport if it ever matters.
			Expect(Response.Body).ToBeNil()
		end)
	end)
end

return Suite
