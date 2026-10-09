--!strict
-- MockTransport stands in for the Outpost backend inside Studio, where a Roblox server can't reach
-- a backend running on this machine. It answers the same routes with the same shapes, keeps wallets
-- in memory and honours Idempotency-Key, so the shop and orbs behave the way they do live.
-- It also refuses what the backend refuses, with the same status and error code. That covers bad
-- bodies, bad keys, ids that are not uuids, telemetry outside the allow lists and earns over the cap.
-- The contract suite runs against this mock and against the real backend, so the two can't drift
-- apart without one of those runs failing.
-- Nothing here touches game. The catalog, flags, telemetry allow lists and clock are passed in.
-- The second thing new hands back is a set of Controls, so a spec or a Studio tester can make the
-- next call fail, lose an answer, flip a flag or throw away every token.
--
-- What the mock does not model, so a Studio test can't rely on it.
-- There is one service client. The real backend only lets the client that made a purchase
-- acknowledge it, and hashes the client into every key, so another client reusing a key is a 409.
-- There are no scopes, so it never answers 403 insufficient_scope.
-- The token trade never fails. Any ApiKey string works, and FailNext skips the trade, so an auth
-- outage (a bad key, or a 429 or 503 on the trade) can't be tried out here.
-- There is no real rate limiter (FailNext is the only 429) and no byte limits, so no 413.
-- It gets Lua tables, not JSON. Something that encodes differently on the wire, like a NaN or a
-- table with mixed keys, can pass here and fail live. Empty dims are the one case it refuses.
-- The purchase list keeps insertion order with no cap of 100 and no refunds. The real one orders
-- by time and then a random id, so two purchases in the same millisecond may come back swapped.
-- TelemetryEnabled takes effect at once, where the real route reads flags through a 5 second cache.
-- FailNext answers before the body is checked, where a real 503 only comes after it.

export type Response = { Ok: boolean, Status: number, Body: any, Headers: { [string]: string } }
-- Copies of the types in BackendClient. The mock answers at once, so it ignores TimeoutSeconds.
export type TransportRequest = {
	Method: string,
	Url: string,
	Headers: { [string]: any },
	Body: any?,
	TimeoutSeconds: number?,
}
export type Transport = (Request: TransportRequest) -> Response
export type Catalog = { [string]: { DisplayName: string, Price: number } }
-- The parts of Configs/Telemetry the mock checks events against.
export type Schema = { EventNames: { string }, DimValues: { [string]: { string } }, MaxEventsPerBatch: number }

export type Controls = {
	-- The next Count calls to a /v1 route answer Status with this error code, and a Retry-After
	-- header when RetryAfter is given. Count defaults to 1. The token trade is never failed.
	FailNext: (Status: number, Code: string, RetryAfter: number?, Count: number?) -> (),
	-- The next call to a /v1 route does its work, then answers Status 0 as if the reply got lost.
	LoseNextAnswer: () -> (),
	SetFlag: (Key: string, Value: any) -> (),
	-- Forgets every token handed out, so the next call gets a 401 and has to trade again.
	ExpireTokens: () -> (),
}

type Prior = { Hash: string, Result: { [string]: any } }
type Purchase = { transactionId: string, userId: number, itemId: string, createdAt: string, fulfilled: boolean }
type Fault = { Status: number, Code: string, RetryAfter: number?, Remaining: number }
type Handler = (Capture: string, Query: string, Body: any, Headers: { [string]: any }) -> Response

local MockTransport = {}

-- MAX_EARN_PER_TRANSACTION and EARN_REASONS in backend/src/modules/economy/plan.ts.
MockTransport.MaxEarn = 1000
MockTransport.EarnReasons = table.freeze({ "orbs", "legacy_migration" })
-- MAX_FUTURE_SKEW_MS and MAX_EVENT_AGE_MS in backend/src/modules/telemetry/schema.ts.
MockTransport.MaxFutureSkewMs = 5 * 60000
MockTransport.MaxEventAgeMs = 24 * 60 * 60000

local MaxSafeInteger = 9007199254740991
local MaxEventValue = 1e9
local TokenSeconds = 900
local TokenScope = "game:economy game:telemetry game:flags.read"

local EarnFields: { [string]: boolean } = { kind = true, userId = true, amount = true, reason = true }
local PurchaseFields: { [string]: boolean } = { kind = true, userId = true, itemId = true }
local EventFields: { [string]: boolean } = { name = true, ts = true, userId = true, value = true, dims = true }
local BatchFields: { [string]: boolean } = { events = true }

local function Reply(Status: number, Body: any?, Headers: { [string]: string }?): Response
	return { Ok = Status >= 200 and Status < 300, Status = Status, Body = Body, Headers = Headers or {} }
end

local function Fail(Status: number, Code: string, Headers: { [string]: string }?): Response
	return Reply(Status, { error = Code, message = Code }, Headers)
end

local function Invalid(): Response
	return Fail(400, "invalid_request")
end

local function IsWhole(Value: any, Low: number, High: number): boolean
	return type(Value) == "number" and Value == Value and Value % 1 == 0 and Value >= Low and Value <= High
end

local function IsUserIdBody(Value: any): boolean
	return IsWhole(Value, 1, MaxSafeInteger)
end

-- True when every key is a string the Allowed set knows, the way a strict zod object checks.
local function HasOnly(Value: any, Allowed: { [string]: boolean }): boolean
	if type(Value) ~= "table" then
		return false
	end
	for Key in Value do
		if type(Key) ~= "string" or not Allowed[Key] then
			return false
		end
	end
	return true
end

-- True for a list with no holes and no other keys, which is what a JSON array decodes to.
local function IsArray(Value: any): boolean
	if type(Value) ~= "table" then
		return false
	end
	local Count = 0
	for _ in Value do
		Count += 1
	end
	return Count == #Value
end

-- Finds a header whatever case it was sent in, the way HTTP treats header names.
local function Header(Headers: { [string]: any }, Name: string): any
	for Key, Value in Headers do
		if type(Key) == "string" and string.lower(Key) == Name then
			return Value
		end
	end
	return nil
end

-- The backend's key rule, 8 to 128 letters, digits, colons, underscores or dashes.
function MockTransport.IsIdempotencyKey(Key: any): boolean
	return type(Key) == "string" and #Key >= 8 and #Key <= 128 and string.match(Key, "^[%w:_%-]+$") ~= nil
end

-- The backend's id rule, zod's uuid check. The version digit is 1 to 8 and the variant digit is
-- 8, 9, a or b in either case. The all zero id and the lowercase all f id are allowed on their own.
local UuidRule = "^%x%x%x%x%x%x%x%x%-%x%x%x%x%-[1-8]%x%x%x%-[89abAB]%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$"
local SpecialUuids: { [string]: boolean } = {
	["00000000-0000-0000-0000-000000000000"] = true,
	["ffffffff-ffff-ffff-ffff-ffffffffffff"] = true,
}

function MockTransport.IsTransactionId(Value: any): boolean
	return type(Value) == "string" and (SpecialUuids[Value] == true or string.match(Value, UuidRule) ~= nil)
end

-- A UserId in a path is digits with no leading zero and a safe integer. The backend also caps it
-- at 16 digits, but every 17 digit number is past the safe integer limit anyway.
local function PathUserId(Text: string): number?
	if string.match(Text, "^[1-9]%d*$") == nil then
		return nil
	end
	local Number = tonumber(Text)
	if Number == nil or Number > MaxSafeInteger then
		return nil
	end
	return Number
end

local function IsoTime(Millis: number): string
	local Seconds = math.floor(Millis / 1000)
	return `{os.date("!%Y-%m-%dT%H:%M:%S", Seconds)}.{string.format("%03d", Millis - Seconds * 1000)}Z`
end

local function CheckEarn(Body: any): boolean
	return HasOnly(Body, EarnFields)
		and IsUserIdBody(Body.userId)
		and IsWhole(Body.amount, 1, MockTransport.MaxEarn)
		and table.find(MockTransport.EarnReasons, Body.reason) ~= nil
end

local function CheckPurchase(Body: any, Catalog: Catalog): boolean
	return HasOnly(Body, PurchaseFields)
		and IsUserIdBody(Body.userId)
		and type(Body.itemId) == "string"
		and type(Catalog[Body.itemId]) == "table"
end

-- An empty table or a list goes over the wire as a JSON array, and the server's strict dims object
-- refuses an array, so the mock refuses both too.
local function CheckDims(Dims: any, Schema: Schema): boolean
	if type(Dims) ~= "table" or next(Dims) == nil then
		return false
	end
	for Key, Value in Dims do
		local Allowed = if type(Key) == "string" then Schema.DimValues[Key] else nil
		if Allowed == nil or type(Value) ~= "string" or table.find(Allowed, Value) == nil then
			return false
		end
	end
	return true
end

local function CheckEvent(Event: any, Schema: Schema): boolean
	if not HasOnly(Event, EventFields) then
		return false
	end
	if type(Event.name) ~= "string" or table.find(Schema.EventNames, Event.name) == nil then
		return false
	end
	if not IsWhole(Event.ts, 1, MaxSafeInteger) then
		return false
	end
	if Event.userId ~= nil and not IsUserIdBody(Event.userId) then
		return false
	end
	local Value = Event.value
	if Value ~= nil and not (type(Value) == "number" and Value >= -MaxEventValue and Value <= MaxEventValue) then
		return false
	end
	return Event.dims == nil or CheckDims(Event.dims, Schema)
end

local function CheckBatch(Body: any, Schema: Schema): boolean
	if not HasOnly(Body, BatchFields) or not IsArray(Body.events) then
		return false
	end
	local Count = #Body.events
	if Count < 1 or Count > Schema.MaxEventsPerBatch then
		return false
	end
	for _, Event in Body.events do
		if not CheckEvent(Event, Schema) then
			return false
		end
	end
	return true
end

-- The fields that make two requests the same request. The body was checked first, so these are
-- all there is in it.
local function HashOf(Body: any): string
	local UserId = string.format("%d", Body.userId)
	return `{Body.kind}|{UserId}|{tostring(Body.amount)}|{tostring(Body.reason)}|{tostring(Body.itemId)}`
end

function MockTransport.new(
	Catalog: Catalog,
	Flags: { [string]: any },
	Schema: Schema,
	NowMillis: () -> number
): (Transport, Controls)
	local CurrentFlags: { [string]: any } = table.clone(Flags)
	local Balances: { [number]: number } = {}
	local ByKey: { [string]: Prior } = {}
	local Purchases: { Purchase } = {}
	local Tokens: { [string]: boolean } = {}
	local Faults: { Fault } = {}
	local LoseNext = false
	local IdCounter = 0
	local TokenCounter = 0

	local function NextId(): string
		IdCounter += 1
		return string.format("00000000-0000-4000-8000-%012d", IdCounter)
	end

	local function Trade(Headers: { [string]: any }): Response
		local Key = Header(Headers, "authorization")
		-- In game the key is a Roblox Secret, which is not a string, so only a plain string is checked.
		if Key == nil or (type(Key) == "string" and string.sub(Key, 1, 7) ~= "ApiKey ") then
			return Fail(401, "unauthorized")
		end
		TokenCounter += 1
		local Token = `mock-token-{TokenCounter}`
		Tokens[Token] = true
		return Reply(200, { accessToken = Token, tokenType = "Bearer", expiresIn = TokenSeconds, scope = TokenScope })
	end

	local function HasToken(Headers: { [string]: any }): boolean
		local Value = Header(Headers, "authorization")
		local Token = if type(Value) == "string" then string.match(Value, "^Bearer (%S+)$") else nil
		return Token ~= nil and Tokens[Token] == true
	end

	local function Join(Capture: string): Response
		local UserId = PathUserId(Capture)
		if UserId == nil then
			return Invalid()
		end
		Balances[UserId] = Balances[UserId] or 0
		return Reply(200, { userId = UserId, balance = Balances[UserId] })
	end

	local function Leave(Capture: string): Response
		local UserId = PathUserId(Capture)
		if UserId == nil then
			return Invalid()
		end
		return if Balances[UserId] ~= nil then Reply(204) else Fail(404, "player_not_found")
	end

	local function Wallet(Capture: string): Response
		local UserId = PathUserId(Capture)
		if UserId == nil then
			return Invalid()
		end
		local Balance = Balances[UserId]
		return if Balance ~= nil
			then Reply(200, { userId = UserId, balance = Balance })
			else Fail(404, "player_not_found")
	end

	-- The same steps as the ledger. Check the request, replay a known key, then check the player
	-- and the balance, and only then write.
	local function Transact(_Capture: string, _Query: string, Body: any, Headers: { [string]: any }): Response
		local Key = Header(Headers, "idempotency-key")
		if not MockTransport.IsIdempotencyKey(Key) then
			return Invalid()
		end
		local Kind = if type(Body) == "table" then Body.kind else nil
		if Kind == "earn" then
			if not CheckEarn(Body) then
				return Invalid()
			end
		elseif Kind == "purchase" then
			if not CheckPurchase(Body, Catalog) then
				return Invalid()
			end
		else
			return Invalid()
		end
		local Hash = HashOf(Body)
		local Prior = ByKey[Key]
		if Prior ~= nil then
			if Prior.Hash ~= Hash then
				return Fail(409, "idempotency_key_reuse")
			end
			local Replayed = table.clone(Prior.Result)
			Replayed.replayed = true
			return Reply(200, Replayed, { ["idempotent-replayed"] = "true" })
		end
		local UserId: number = Body.userId
		local Before = Balances[UserId]
		if Before == nil then
			return Fail(404, "player_not_found")
		end
		local Delta = if Kind == "earn" then Body.amount else -Catalog[Body.itemId].Price
		local After = Before + Delta
		if After < 0 then
			return Fail(422, "insufficient_funds")
		end
		Balances[UserId] = After
		local CreatedAt = IsoTime(NowMillis())
		local ItemId: string? = if Kind == "purchase" then Body.itemId else nil
		local Result: { [string]: any } = {
			transactionId = NextId(),
			kind = Kind,
			userId = UserId,
			amount = Delta,
			balanceAfter = After,
			itemId = ItemId,
			createdAt = CreatedAt,
			replayed = false,
		}
		ByKey[Key] = { Hash = Hash, Result = Result }
		if ItemId ~= nil then
			table.insert(Purchases, {
				transactionId = Result.transactionId,
				userId = UserId,
				itemId = ItemId,
				createdAt = CreatedAt,
				fulfilled = false,
			})
		end
		return Reply(201, table.clone(Result))
	end

	local function Fulfilled(Capture: string): Response
		if not MockTransport.IsTransactionId(Capture) then
			return Invalid()
		end
		for _, Purchase in Purchases do
			if Purchase.transactionId == Capture then
				Purchase.fulfilled = true
				return Reply(204)
			end
		end
		return Fail(404, "purchase_not_found")
	end

	local function Unfulfilled(Capture: string, Query: string): Response
		local UserId = PathUserId(Capture)
		if UserId == nil or Query ~= "unfulfilled=1" then
			return Invalid()
		end
		local List = {}
		for _, Purchase in Purchases do
			if Purchase.userId == UserId and not Purchase.fulfilled then
				table.insert(List, {
					transactionId = Purchase.transactionId,
					itemId = Purchase.itemId,
					createdAt = Purchase.createdAt,
				})
			end
		end
		return Reply(200, { purchases = List })
	end

	-- The whole batch is checked first. Then TelemetryEnabled false drops every event, and
	-- otherwise events too far ahead or too old are dropped and counted.
	local function TelemetryBatch(_Capture: string, _Query: string, Body: any): Response
		if not CheckBatch(Body, Schema) then
			return Invalid()
		end
		local Count = #Body.events
		if CurrentFlags.TelemetryEnabled == false then
			return Reply(202, { accepted = 0, dropped = Count })
		end
		local Now = NowMillis()
		local Kept = 0
		for _, Event in Body.events do
			if Event.ts <= Now + MockTransport.MaxFutureSkewMs and Event.ts >= Now - MockTransport.MaxEventAgeMs then
				Kept += 1
			end
		end
		return Reply(202, { accepted = Kept, dropped = Count - Kept })
	end

	local function ListFlags(): Response
		return Reply(200, { flags = table.clone(CurrentFlags) })
	end

	local Routes: { { Method: string, Pattern: string, Handler: Handler } } = {
		{ Method = "POST", Pattern = "^/v1/players/([^/]+)/sessions$", Handler = Join },
		{ Method = "POST", Pattern = "^/v1/players/([^/]+)/sessions/end$", Handler = Leave },
		{ Method = "GET", Pattern = "^/v1/players/([^/]+)/wallet$", Handler = Wallet },
		{ Method = "GET", Pattern = "^/v1/players/([^/]+)/purchases$", Handler = Unfulfilled },
		{ Method = "POST", Pattern = "^/v1/economy/transactions()$", Handler = Transact },
		{ Method = "POST", Pattern = "^/v1/economy/transactions/([^/]+)/fulfilled$", Handler = Fulfilled },
		{ Method = "POST", Pattern = "^/v1/telemetry/batch()$", Handler = TelemetryBatch },
		{ Method = "GET", Pattern = "^/v1/flags()$", Handler = ListFlags },
	}

	local function Transport(Request: TransportRequest): Response
		local Full = string.match(Request.Url, "^https?://[^/]+(/.*)$") or Request.Url
		local Path, Query = string.match(Full, "^([^?]*)%??(.*)$")
		local Headers = Request.Headers or {}
		if Request.Method == "POST" and Path == "/auth/service-token" then
			return Trade(Headers)
		end
		local Handler: Handler? = nil
		local Capture = ""
		for _, Route in Routes do
			local Found = string.match(Path or "", Route.Pattern)
			if Found ~= nil and Route.Method == Request.Method then
				Handler = Route.Handler
				Capture = tostring(Found)
				break
			end
		end
		-- Like the backend, an unknown route is a 404 before anyone looks at the token.
		if Handler == nil then
			return Fail(404, "not_found")
		end
		if not HasToken(Headers) then
			return Fail(401, "unauthorized", { ["www-authenticate"] = "Bearer" })
		end
		local Next = Faults[1]
		if Next ~= nil then
			Next.Remaining -= 1
			if Next.Remaining <= 0 then
				table.remove(Faults, 1)
			end
			local FaultHeaders: { [string]: string } = {}
			if Next.RetryAfter ~= nil then
				FaultHeaders["retry-after"] = string.format("%d", Next.RetryAfter)
			end
			return Fail(Next.Status, Next.Code, FaultHeaders)
		end
		local Result = Handler(Capture, Query or "", Request.Body, Headers)
		if LoseNext then
			LoseNext = false
			return Reply(0)
		end
		return Result
	end

	local Controls: Controls = {
		FailNext = function(Status: number, Code: string, RetryAfter: number?, Count: number?)
			table.insert(Faults, { Status = Status, Code = Code, RetryAfter = RetryAfter, Remaining = Count or 1 })
		end,
		LoseNextAnswer = function()
			LoseNext = true
		end,
		SetFlag = function(Key: string, Value: any)
			CurrentFlags[Key] = Value
		end,
		ExpireTokens = function()
			table.clear(Tokens)
		end,
	}

	return Transport, Controls
end

return MockTransport
