--!strict
-- PurchaseFlow turns the backend's reply to a purchase into what the shop should do.
-- Grant means the Coins were taken, so give the item and then acknowledge it.
-- Refuse means a definite no, like not enough Coins. The backend did no work.
-- RetryLater means we can't tell yet, for example a timeout after the backend may already have
-- charged. The caller keeps the same Idempotency-Key for that player and item until it gets a
-- Grant or a Refuse, so the next try replays the first one instead of charging again. Anything
-- still unsettled when the player leaves is fixed by the reconcile on their next join, because an
-- unacknowledged purchase is always granted then.

export type Response = { Ok: boolean, Status: number, Body: any }
export type Decision = {
	Action: "Grant" | "Refuse" | "RetryLater",
	Outcome: string,
	TransactionId: string?,
	BalanceAfter: number?,
}
export type Plan = { Grant: { string }, Ack: { string } }

-- The bits of BackendClient and Requests that Submit uses. They are passed in, so this module
-- requires nothing.
export type Client = { Send: (self: any, Request: any, Options: any) -> Response }
export type Builders = { Purchase: (UserId: number, ItemId: string, Key: string) -> any }

local PurchaseFlow = {}

-- A player is waiting on the shop, so a purchase gives up after this many seconds and answers
-- RetryLater instead of sitting out a long Retry-After or a slow token trade.
PurchaseFlow.DeadlineSeconds = 10

local function RetryLater(): Decision
	return { Action = "RetryLater", Outcome = "Unavailable" }
end

-- The client errors that are not a definite no. A 404 means the player's join has not landed
-- yet, a 408 or 425 means the backend did no work this time, and a 429 asks us to slow down.
local function IsTemporaryClientError(Status: number): boolean
	return Status == 404 or Status == 408 or Status == 425 or Status == 429
end

function PurchaseFlow.Decide(Response: Response): Decision
	local Status = Response.Status
	local Body = if type(Response.Body) == "table" then Response.Body else {}
	if Status == 200 or Status == 201 then
		local Balance = Body.balanceAfter
		if type(Body.transactionId) == "string" and type(Balance) == "number" and Balance == Balance then
			return {
				Action = "Grant",
				Outcome = "Granted",
				TransactionId = Body.transactionId,
				BalanceAfter = Balance,
			}
		end
		return RetryLater()
	end
	if Status >= 400 and Status <= 499 and not IsTemporaryClientError(Status) then
		if Status == 422 and Body.error == "insufficient_funds" then
			return { Action = "Refuse", Outcome = "TooPoor" }
		end
		return { Action = "Refuse", Outcome = "Unavailable" }
	end
	-- Everything else leaves us unsure. That is no answer, a refusal made on this server such as an
	-- open breaker or the deadline (any status below zero), a 5xx, or a 1xx, 2xx or 3xx we don't expect.
	return RetryLater()
end

-- Sends one purchase with the caller's key and decides the answer. Requests checks the key and
-- the UserId first and throws on a bad one, before anything is sent.
function PurchaseFlow.Submit(
	Client: Client,
	Build: Builders,
	UserId: number,
	ItemId: string,
	Key: string
): (Decision, Response)
	local Request = Build.Purchase(UserId, ItemId, Key)
	local Response = Client:Send(Request, { DeadlineSeconds = PurchaseFlow.DeadlineSeconds })
	return PurchaseFlow.Decide(Response), Response
end

-- Works out what to do with purchases the backend says were never acknowledged.
-- Items the player lacks get granted, every known purchase gets acknowledged once, and an item id
-- the game does not know is left alone so an operator can look at it.
function PurchaseFlow.ReconcilePlan(
	Purchases: any,
	Owned: { [string]: boolean },
	KnownItems: { [string]: string }
): Plan
	local Result: Plan = { Grant = {}, Ack = {} }
	if type(Purchases) ~= "table" then
		return Result
	end
	local Granting: { [string]: boolean } = {}
	local Acking: { [string]: boolean } = {}
	for _, Purchase in Purchases do
		if type(Purchase) ~= "table" then
			continue
		end
		local ItemId = Purchase.itemId
		local TransactionId = Purchase.transactionId
		if type(ItemId) ~= "string" or type(TransactionId) ~= "string" or KnownItems[ItemId] ~= ItemId then
			continue
		end
		if not Owned[ItemId] and not Granting[ItemId] then
			Granting[ItemId] = true
			table.insert(Result.Grant, ItemId)
		end
		if not Acking[TransactionId] then
			Acking[TransactionId] = true
			table.insert(Result.Ack, TransactionId)
		end
	end
	return Result
end

return PurchaseFlow
