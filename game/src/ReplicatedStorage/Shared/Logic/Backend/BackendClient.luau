--!strict
-- BackendClient sends the game server's requests to the Outpost backend.
-- It trades the API key for a short lived token and reuses it until a minute before it runs out.
-- Only one trade is ever in flight. Threads that need a token while one is on its way wait for it.
-- Every call goes through an HTTP budget, so the server stays under Roblox's limit of 500 requests
-- a minute, and through a circuit breaker, so a dead backend costs no waiting.
-- There is one breaker per route group, so an economy outage cannot block telemetry or flags.
-- Retryable failures are tried again with backoff using the same request, and so the same
-- Idempotency-Key, which is what makes a retried purchase safe. A server Retry-After is honoured.
-- Each call has a deadline. When the next wait would pass it the call gives up with RetryLater.
-- Nothing here touches game. The transport, clock, sleep and randomness are passed in.

-- Headers on a Response always use lowercase names, for example retry-after.
export type Response = { Ok: boolean, Status: number, Body: any, Headers: { [string]: string } }
export type TransportRequest = { Method: string, Url: string, Headers: { [string]: any }, Body: any? }
-- A transport never throws and answers Status 0 when nothing came back. If one throws anyway the
-- client treats it as Status 0.
export type Transport = (Request: TransportRequest) -> Response
export type OutboundRequest = { Method: string, Path: string, Headers: { [string]: string }?, Body: any? }

export type RetryRules = {
	ShouldRetry: (Policy: any, Attempt: number, Status: number) -> boolean,
	DelayFor: (Policy: any, Attempt: number, RandomUnit: number, RetryAfter: number?) -> number,
	ParseRetryAfter: (Value: string?) -> number?,
}

export type Group = "Auth" | "Economy" | "Telemetry" | "Flags"

-- One CircuitBreaker for each route group.
export type Breakers = { Auth: any, Economy: any, Telemetry: any, Flags: any }

export type Deps = {
	BaseUrl: string,
	Transport: Transport,
	ApiKeyHeader: any, -- a plain string in tests, a Roblox Secret with an "ApiKey " prefix in game
	Now: () -> number,
	Sleep: (Seconds: number) -> (),
	RandomUnit: () -> number,
	Retry: RetryRules,
	Policy: any,
	Breakers: Breakers,
	Budget: any, -- a RateLimiter, spent with the key "http"
	-- Wakes a thread that was waiting for the token, passing it the result. In game pass task.spawn.
	-- When it is left out coroutine.resume is used, which is what the Lune specs rely on.
	Resume: ((Thread: thread, ...any) -> ())?,
}

export type SendOptions = {
	-- How many seconds this call may take in total, waits included. Defaults to DefaultDeadlineSeconds.
	DeadlineSeconds: number?,
}

type Exchange = { Waiters: { thread } }

type Fields = {
	Deps: Deps,
	Token: string?,
	TokenExpiresAt: number,
	Exchanging: Exchange?,
}

local BackendClient = {}
BackendClient.__index = BackendClient

-- Statuses below zero are refusals made right here, before or instead of any HTTP.
BackendClient.BreakerOpen = -1
BackendClient.OverBudget = -2
-- The next wait would have passed the call's deadline, so we stopped. The backend may or may not
-- have done the work, so treat it like a timeout and try again later with the same key.
BackendClient.RetryLater = -3

-- Long enough for two full Retry-After waits, so background calls rarely give up early.
-- User facing calls such as a purchase should pass a much shorter deadline.
BackendClient.DefaultDeadlineSeconds = 120

local GroupNames: { Group } = { "Auth", "Economy", "Telemetry", "Flags" }
BackendClient.Groups = table.freeze(GroupNames)

export type BackendClient = typeof(setmetatable({} :: Fields, BackendClient))

local RefreshMarginSeconds = 60
local ServiceTokenPath = "/auth/service-token"

-- Worst first, for BreakerState with no group.
local StateRank: { [string]: number } = { Closed = 1, HalfOpen = 2, Open = 3 }

local function Refusal(Status: number, Headers: { [string]: string }?): Response
	return { Ok = false, Status = Status, Body = nil, Headers = Headers or {} }
end

-- Players and sessions share the ledger database with the economy routes, so they share its breaker.
function BackendClient.GroupFor(Path: string): Group
	if string.sub(Path, 1, 6) == "/auth/" then
		return "Auth"
	elseif string.sub(Path, 1, 14) == "/v1/telemetry/" then
		return "Telemetry"
	elseif Path == "/v1/flags" or string.sub(Path, 1, 10) == "/v1/flags?" then
		return "Flags"
	end
	return "Economy"
end

function BackendClient.new(Deps: Deps): BackendClient
	for _, Name in BackendClient.Groups do
		if (Deps.Breakers :: any)[Name] == nil then
			error(`BackendClient needs a breaker for the {Name} group`, 2)
		end
	end
	local Object: Fields = { Deps = Deps, Token = nil, TokenExpiresAt = 0, Exchanging = nil }
	return setmetatable(Object, BackendClient)
end

-- Fills in what a sloppy transport left out, and drops any body on a 204, which has none.
local function Tidy(Result: any): Response
	if type(Result) ~= "table" or type(Result.Status) ~= "number" then
		return Refusal(0)
	end
	local Headers = if type(Result.Headers) == "table" then Result.Headers else {}
	local Body = if Result.Status == 204 then nil else Result.Body
	return { Ok = Result.Ok == true, Status = Result.Status, Body = Body, Headers = Headers }
end

-- One HTTP call. The budget is checked before the breaker, so a call the budget refuses can never
-- take the breaker's single half open probe.
local function SendOnce(self: BackendClient, Request: OutboundRequest, Authorization: any): Response
	local Deps = self.Deps
	local Breaker = (Deps.Breakers :: any)[BackendClient.GroupFor(Request.Path)]
	local Now = Deps.Now()
	if not Deps.Budget:Allow("http", Now) then
		return Refusal(BackendClient.OverBudget)
	end
	if not Breaker:Allow(Now) then
		return Refusal(BackendClient.BreakerOpen)
	end
	local Headers: { [string]: any } = table.clone(Request.Headers or {})
	Headers["Authorization"] = Authorization
	if Request.Body ~= nil then
		Headers["Content-Type"] = "application/json"
	end
	local Worked, Raw = pcall(Deps.Transport, {
		Method = Request.Method,
		Url = Deps.BaseUrl .. Request.Path,
		Headers = Headers,
		Body = Request.Body,
	})
	local Result = if Worked then Tidy(Raw) else Refusal(0)
	Breaker:RecordResult(Deps.Now(), Result.Status)
	return Result
end

-- Sends and retries until a definite answer, the attempt limit or the deadline.
local function SendWithRetry(
	self: BackendClient,
	Request: OutboundRequest,
	Authorization: any,
	Deadline: number
): Response
	local Deps = self.Deps
	local Retry = Deps.Retry
	local Attempt = 1
	local Result = SendOnce(self, Request, Authorization)
	while Result.Status >= 0 and Retry.ShouldRetry(Deps.Policy, Attempt, Result.Status) do
		local RetryAfter = Retry.ParseRetryAfter(Result.Headers["retry-after"])
		local Delay = Retry.DelayFor(Deps.Policy, Attempt, Deps.RandomUnit(), RetryAfter)
		if Deps.Now() + Delay > Deadline then
			return Refusal(BackendClient.RetryLater, Result.Headers)
		end
		Deps.Sleep(Delay)
		Attempt += 1
		Result = SendOnce(self, Request, Authorization)
	end
	return Result
end

-- Does the actual trade of the API key for a token. Only ever runs once at a time.
local function Trade(self: BackendClient, Deadline: number): (string?, Response?)
	local Deps = self.Deps
	local Request: OutboundRequest = { Method = "POST", Path = ServiceTokenPath, Body = {} }
	local Result = SendWithRetry(self, Request, Deps.ApiKeyHeader, Deadline)
	local Body = Result.Body
	if Result.Status ~= 200 then
		return nil, Result
	end
	if type(Body) ~= "table" or type(Body.accessToken) ~= "string" then
		return nil, Refusal(0)
	end
	local Lifetime = tonumber(Body.expiresIn) or 0
	self.Token = Body.accessToken
	self.TokenExpiresAt = Deps.Now() + math.max(0, Lifetime - RefreshMarginSeconds)
	return Body.accessToken, nil
end

-- Hands back a token that is good for at least another minute, trading the key if needed.
-- If a trade is already on its way this thread waits for it and shares its token or its failure.
-- A failed trade is never remembered, so the next call simply tries again.
local function EnsureToken(self: BackendClient, Deadline: number): (string?, Response?)
	local Current = self.Token
	if Current ~= nil and self.Deps.Now() < self.TokenExpiresAt then
		return Current, nil
	end
	local Pending = self.Exchanging
	if Pending ~= nil and coroutine.isyieldable() then
		table.insert(Pending.Waiters, coroutine.running())
		return coroutine.yield()
	end
	local Mine: Exchange = { Waiters = {} }
	self.Exchanging = Mine
	local Worked, Token, Failure = pcall(Trade, self, Deadline)
	if not Worked then
		Token, Failure = nil, Refusal(0)
	end
	if self.Exchanging == Mine then
		self.Exchanging = nil
	end
	local Resume = self.Deps.Resume
	for _, Waiter in Mine.Waiters do
		if Resume ~= nil then
			Resume(Waiter, Token, Failure)
		else
			coroutine.resume(Waiter, Token, Failure)
		end
	end
	return Token, Failure
end

-- Sends a request with the service token, and gets a fresh token once if the backend answers 401.
-- Options can set a DeadlineSeconds for the whole call, waits and the token trade included.
function BackendClient.Send(self: BackendClient, Request: OutboundRequest, Options: SendOptions?): Response
	local Seconds = if Options and Options.DeadlineSeconds
		then Options.DeadlineSeconds
		else BackendClient.DefaultDeadlineSeconds
	local Deadline = self.Deps.Now() + Seconds
	local Token, Failure = EnsureToken(self, Deadline)
	if Token == nil then
		return Failure or Refusal(0)
	end
	local Result = SendWithRetry(self, Request, `Bearer {Token}`, Deadline)
	if Result.Status == 401 then
		-- Only drop the token if nobody has swapped in a newer one while we were waiting.
		if self.Token == Token then
			self.Token = nil
		end
		Token, Failure = EnsureToken(self, Deadline)
		if Token == nil then
			return Failure or Refusal(0)
		end
		Result = SendWithRetry(self, Request, `Bearer {Token}`, Deadline)
	end
	return Result
end

-- The state of one group's breaker, or with no group the worst state across all of them.
function BackendClient.BreakerState(self: BackendClient, Group: Group?): string
	local Breakers = self.Deps.Breakers :: any
	if Group ~= nil then
		return Breakers[Group]:State()
	end
	local Worst = "Closed"
	for _, Name in BackendClient.Groups do
		local State = Breakers[Name]:State()
		if StateRank[State] > StateRank[Worst] then
			Worst = State
		end
	end
	return Worst
end

return BackendClient
