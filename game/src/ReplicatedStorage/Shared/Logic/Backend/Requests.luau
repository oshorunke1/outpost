--!strict
-- Requests builds every call the game server makes to the Outpost backend as a plain table.
-- It never sends anything. BackendClient does that, which keeps these easy to check in tests.
-- Paths and fields must match contracts/openapi.yaml, and the contract suite proves they do.
-- The JSON field names are camelCase because that is the HTTP contract, not Luau naming.
-- Every builder checks its ids before it puts them in a path, and throws on a bad one, because
-- a quietly mangled id would point the call at some other player or some other route.

export type Request = {
	Method: string,
	Path: string,
	Headers: { [string]: string }?,
	Body: { [string]: any }?,
}

export type TelemetryEvent = {
	name: string,
	ts: number,
	userId: number?,
	value: number?,
	dims: { [string]: string }?,
}

local Requests = {}

-- The biggest whole number a JSON number can hold exactly, and the backend's own upper bound.
local MaxSafeInteger = 9007199254740991

-- The longest JobId part we keep, so a key with a long scope and counter still fits in 128.
local MaxBootTagLength = 64

local function IsWholeInRange(Value: any, Low: number, High: number): boolean
	return type(Value) == "number" and Value == Value and Value % 1 == 0 and Value >= Low and Value <= High
end

-- string.format keeps a big UserId as plain digits, where tostring could switch to exponent style.
-- It also cuts 1.5 down to 1 without a word, which is why the check comes first.
local function IdText(UserId: number): string
	if not IsWholeInRange(UserId, 1, MaxSafeInteger) then
		error(`{UserId} is not a UserId`, 3)
	end
	return string.format("%d", UserId)
end

local function CheckUserId(UserId: number): number
	IdText(UserId)
	return UserId
end

-- True when the key passes the backend's rule, 8 to 128 letters, digits, colons, underscores or dashes.
function Requests.IsIdempotencyKey(Key: string): boolean
	return type(Key) == "string" and #Key >= 8 and #Key <= 128 and string.match(Key, "^[%w:_%-]+$") ~= nil
end

local function CheckKey(Key: string): string
	if not Requests.IsIdempotencyKey(Key) then
		error(`{Key} is not an idempotency key`, 3)
	end
	return Key
end

-- The part of every key that is different on each server boot. A live server has a unique JobId,
-- so we use that. Studio has an empty JobId, so there we use a random hex nonce the caller made.
function Requests.BootTag(JobId: string?, Nonce: string): string
	local Stripped = string.gsub(JobId or "", "[^%w_%-]", "")
	local Clean = string.sub(Stripped, 1, MaxBootTagLength)
	if Clean ~= "" then
		return Clean
	end
	if type(Nonce) ~= "string" or #Nonce < 8 or #Nonce > 32 or string.match(Nonce, "^%x+$") == nil then
		error(`the boot nonce must be 8 to 32 hex characters, got {Nonce}`, 2)
	end
	return `boot-{Nonce}`
end

-- Builds a key from the boot tag, a scope such as the UserId and a counter, joined by colon
-- characters, so boot tag boot-0badf00d, scope 1001 and counter 4 give the key the spec shows.
function Requests.IdempotencyKey(BootTag: string, Scope: string, Counter: number): string
	if not IsWholeInRange(Counter, 1, MaxSafeInteger) then
		error(`the key counter must be a whole number from 1 up, got {Counter}`, 2)
	end
	local Key = `{BootTag}:{Scope}:{string.format("%d", Counter)}`
	if not Requests.IsIdempotencyKey(Key) then
		error(`{Key} is not an idempotency key`, 2)
	end
	return Key
end

function Requests.ServiceToken(): Request
	return { Method = "POST", Path = "/auth/service-token", Body = {} }
end

function Requests.JoinSession(UserId: number): Request
	return { Method = "POST", Path = `/v1/players/{IdText(UserId)}/sessions`, Body = {} }
end

function Requests.LeaveSession(UserId: number): Request
	return { Method = "POST", Path = `/v1/players/{IdText(UserId)}/sessions/end`, Body = {} }
end

function Requests.Wallet(UserId: number): Request
	return { Method = "GET", Path = `/v1/players/{IdText(UserId)}/wallet` }
end

function Requests.Earn(UserId: number, Coins: number, Key: string): Request
	return {
		Method = "POST",
		Path = "/v1/economy/transactions",
		Headers = { ["Idempotency-Key"] = CheckKey(Key) },
		Body = { kind = "earn", userId = CheckUserId(UserId), amount = Coins, reason = "orbs" },
	}
end

function Requests.Purchase(UserId: number, ItemId: string, Key: string): Request
	return {
		Method = "POST",
		Path = "/v1/economy/transactions",
		Headers = { ["Idempotency-Key"] = CheckKey(Key) },
		Body = { kind = "purchase", userId = CheckUserId(UserId), itemId = ItemId },
	}
end

local UuidShape = "^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$"

function Requests.Fulfilled(TransactionId: string): Request
	if type(TransactionId) ~= "string" or string.match(TransactionId, UuidShape) == nil then
		error(`{TransactionId} is not a transaction id`, 2)
	end
	return { Method = "POST", Path = `/v1/economy/transactions/{TransactionId}/fulfilled`, Body = {} }
end

function Requests.Unfulfilled(UserId: number): Request
	return { Method = "GET", Path = `/v1/players/{IdText(UserId)}/purchases?unfulfilled=1` }
end

function Requests.TelemetryBatch(Events: { TelemetryEvent }): Request
	return { Method = "POST", Path = "/v1/telemetry/batch", Body = { events = Events } }
end

function Requests.Flags(): Request
	return { Method = "GET", Path = "/v1/flags" }
end

return Requests
