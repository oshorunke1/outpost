--!strict
-- EarnBatcher adds up the Coins each player earns and hands them out as batches, so orb pickups
-- turn into a few backend calls instead of one per orb.
-- A batch is ready when it reaches MaxCoins, when its first Coin is MaxAgeSeconds old, or when the
-- player leaves. A batch never holds more than MaxCoins, and the backend takes at most 1000 in one
-- earn, so an add that would go past it sends what is waiting first and splits anything bigger.
-- Each batch gets an idempotency key made from the boot tag, the UserId and a counter, so sending
-- the same batch twice can never pay twice. The keys come from Requests, passed in as Keys.
-- A batch that failed for a temporary reason goes back in with the same key and waits a growing,
-- jittered time before it is tried again. After too many tries it is dropped and counted.
-- Coins never leave quietly. A refused add, a batch the backend refused and a batch we gave up on
-- are each counted, so the caller can warn about them.

export type Flush = {
	UserId: number,
	Coins: number,
	Key: string,
	-- How many sends of this batch have failed so far. A fresh batch has 0.
	Attempts: number,
	-- The earliest time it may be sent again. A fresh batch can go at once, so it has 0.
	NextAttemptAt: number,
}

export type Policy = { MaxAttempts: number, BaseDelay: number, MaxDelay: number }

export type Config = {
	BootTag: string,
	MaxCoins: number,
	MaxAgeSeconds: number,
	-- Requests in game, which builds and checks every key.
	Keys: { IdempotencyKey: (BootTag: string, Scope: string, Counter: number) -> string },
	-- RetryPolicy in game, used for the wait between tries.
	Retry: { DelayFor: (Policy: Policy, Attempt: number, RandomUnit: number, RetryAfter: number?) -> number },
	Policy: Policy?,
	RandomUnit: () -> number,
	MaxRetries: number?,
}

-- Accepted means the backend took it. Queued means it will be tried again. Refused means the backend
-- gave a definite no, so it must not be sent again, and it is counted. GaveUp means it failed too
-- many times and was dropped, and it is counted too.
export type Outcome = "Accepted" | "Queued" | "Refused" | "GaveUp"

type Pending = { Coins: number, Since: number }
type Fields = {
	BootTag: string,
	MaxCoins: number,
	MaxAgeSeconds: number,
	Keys: { IdempotencyKey: (BootTag: string, Scope: string, Counter: number) -> string },
	Retry: { DelayFor: (Policy: Policy, Attempt: number, RandomUnit: number, RetryAfter: number?) -> number },
	Policy: Policy,
	RandomUnit: () -> number,
	MaxRetries: number,
	Pending: { [number]: Pending },
	Sequence: { [number]: number },
	Retries: { Flush },
	DroppedBatches: number,
	DroppedCoins: number,
	RefusedBatches: number,
	RefusedCoins: number,
	RejectedAdds: number,
	RejectedCoins: number,
}

local EarnBatcher = {}
EarnBatcher.__index = EarnBatcher

export type EarnBatcher = typeof(setmetatable({} :: Fields, EarnBatcher))

-- The most one earn may carry. This is MAX_EARN_PER_TRANSACTION in backend/src/modules/economy/plan.ts.
EarnBatcher.MaxEarnPerTransaction = 1000

-- Six tries in all, waiting up to 5, 10, 20, 40 and 80 seconds between them, never over 2 minutes.
EarnBatcher.RequeuePolicy = table.freeze({ MaxAttempts = 6, BaseDelay = 5, MaxDelay = 120 }) :: Policy

-- The biggest whole number a JSON number holds exactly, and the backend's top UserId.
local MaxSafeInteger = 9007199254740991

-- One add bigger than this is surely a bug, so it is refused and counted instead of making a pile of batches.
local MaxCoinsPerAdd = 100000

local function IsWhole(Value: any, Low: number, High: number): boolean
	return type(Value) == "number" and Value == Value and Value % 1 == 0 and Value >= Low and Value <= High
end

local function IsFinite(Value: any): boolean
	return type(Value) == "number" and Value == Value and Value ~= math.huge and Value ~= -math.huge
end

local function IsFinitePositive(Value: any): boolean
	return IsFinite(Value) and Value > 0
end

-- A policy that could never give up, or never wait, is a setup mistake, so it fails at once.
local function CheckPolicy(Policy: Policy)
	local Ok = IsWhole(Policy.MaxAttempts, 1, MaxSafeInteger)
		and IsFinitePositive(Policy.BaseDelay)
		and IsFinitePositive(Policy.MaxDelay)
	if not Ok then
		local Got = `{Policy.MaxAttempts}, {Policy.BaseDelay} and {Policy.MaxDelay}`
		error(`the retry Policy needs a whole MaxAttempts and BaseDelay and MaxDelay above 0, got {Got}`, 3)
	end
end

function EarnBatcher.new(Config: Config): EarnBatcher
	if not IsWhole(Config.MaxCoins, 1, EarnBatcher.MaxEarnPerTransaction) then
		error(`MaxCoins must be a whole number from 1 to 1000, got {Config.MaxCoins}`, 2)
	end
	local MaxAge = Config.MaxAgeSeconds
	if not IsFinitePositive(MaxAge) then
		error(`MaxAgeSeconds must be a finite number above 0, got {MaxAge}`, 2)
	end
	local MaxRetries = if Config.MaxRetries == nil then 500 else Config.MaxRetries
	if not IsWhole(MaxRetries, 1, MaxSafeInteger) then
		error(`MaxRetries must be a whole number of at least 1, got {MaxRetries}`, 2)
	end
	local Policy = Config.Policy or EarnBatcher.RequeuePolicy
	CheckPolicy(Policy)
	-- Building one key now means a bad boot tag fails here, not on the first orb.
	Config.Keys.IdempotencyKey(Config.BootTag, "1", 1)
	local Object: Fields = {
		BootTag = Config.BootTag,
		MaxCoins = Config.MaxCoins,
		MaxAgeSeconds = MaxAge,
		Keys = Config.Keys,
		Retry = Config.Retry,
		Policy = Policy,
		RandomUnit = Config.RandomUnit,
		MaxRetries = MaxRetries,
		Pending = {},
		Sequence = {},
		Retries = {},
		DroppedBatches = 0,
		DroppedCoins = 0,
		RefusedBatches = 0,
		RefusedCoins = 0,
		RejectedAdds = 0,
		RejectedCoins = 0,
	}
	return setmetatable(Object, EarnBatcher)
end

local function MakeFlush(self: EarnBatcher, UserId: number, Coins: number): Flush
	local Next = (self.Sequence[UserId] or 0) + 1
	self.Sequence[UserId] = Next
	local Key = self.Keys.IdempotencyKey(self.BootTag, string.format("%d", UserId), Next)
	return { UserId = UserId, Coins = Coins, Key = Key, Attempts = 0, NextAttemptAt = 0 }
end

local function Take(self: EarnBatcher, UserId: number): Flush?
	local Entry: Pending? = self.Pending[UserId]
	if Entry == nil then
		return nil
	end
	self.Pending[UserId] = nil
	return MakeFlush(self, UserId, Entry.Coins)
end

-- Adds Coins for a player and gives back every batch that is now ready, often none.
-- An add is refused, and counted for TakeRejected, when the Coins are not a whole number from 1 to
-- 100000, the UserId is not a real one, or Now is not a finite number. A batch started with a
-- broken clock would never age out, so it is better to refuse it here where it gets counted.
function EarnBatcher.Add(self: EarnBatcher, UserId: number, Coins: number, Now: number): { Flush }
	local Ready: { Flush } = {}
	local Good = IsWhole(UserId, 1, MaxSafeInteger) and IsWhole(Coins, 1, MaxCoinsPerAdd) and IsFinite(Now)
	if not Good then
		self.RejectedAdds += 1
		if IsFinitePositive(Coins) then
			self.RejectedCoins += Coins
		end
		return Ready
	end
	local Entry: Pending? = self.Pending[UserId]
	if Entry ~= nil and Entry.Coins + Coins > self.MaxCoins then
		table.insert(Ready, Take(self, UserId) :: Flush)
		Entry = nil
	end
	if Entry ~= nil then
		-- It still fits, so it joins the waiting batch, and goes once that batch is full.
		Entry.Coins += Coins
		if Entry.Coins == self.MaxCoins then
			table.insert(Ready, Take(self, UserId) :: Flush)
		end
		return Ready
	end
	-- Nothing is waiting now. Full batches go at once and the rest starts a new one.
	local Left = Coins
	while Left >= self.MaxCoins do
		table.insert(Ready, MakeFlush(self, UserId, self.MaxCoins))
		Left -= self.MaxCoins
	end
	if Left > 0 then
		self.Pending[UserId] = { Coins = Left, Since = Now }
	end
	return Ready
end

-- Every retry whose wait is over, in the order they were queued, then every batch whose first
-- Coin is MaxAgeSeconds old.
function EarnBatcher.TakeDue(self: EarnBatcher, Now: number): { Flush }
	local Due: { Flush } = {}
	local Waiting: { Flush } = {}
	for _, Flush in self.Retries do
		table.insert(if Flush.NextAttemptAt <= Now then Due else Waiting, Flush)
	end
	self.Retries = Waiting
	local Aged: { number } = {}
	for UserId, Entry in self.Pending do
		if Now - Entry.Since >= self.MaxAgeSeconds then
			table.insert(Aged, UserId)
		end
	end
	table.sort(Aged)
	for _, UserId in Aged do
		table.insert(Due, Take(self, UserId) :: Flush)
	end
	return Due
end

-- The player is leaving, so their batch goes now whatever its size or age.
function EarnBatcher.TakeFor(self: EarnBatcher, UserId: number): Flush?
	return Take(self, UserId)
end

-- The server is shutting down, so everything goes now, retries that are still waiting included.
function EarnBatcher.TakeAll(self: EarnBatcher): { Flush }
	local All = self.Retries
	self.Retries = {}
	local Users: { number } = {}
	for UserId in self.Pending do
		table.insert(Users, UserId)
	end
	table.sort(Users)
	for _, UserId in Users do
		table.insert(All, Take(self, UserId) :: Flush)
	end
	return All
end

local function CountDropped(self: EarnBatcher, Flush: Flush)
	self.DroppedBatches += 1
	self.DroppedCoins += Flush.Coins
end

-- Call this with the Status every send got back, success included. A 2xx is Accepted. A temporary
-- failure puts the batch back with its original key and a NextAttemptAt, after a jittered wait that
-- grows each time and honours the server's RetryAfter seconds when it sent one. Any other answer is
-- Refused and counted. A full retry list drops its oldest batch to make room and gives it back as
-- the second result, so the caller can log it. A Now that is not a finite number makes the batch
-- due at once, because a broken clock must never park it forever.
function EarnBatcher.Requeue(
	self: EarnBatcher,
	Flush: Flush,
	Status: number,
	Now: number,
	RetryAfter: number?
): (Outcome, Flush?)
	if type(Status) == "number" and Status >= 200 and Status < 300 then
		return "Accepted", nil
	end
	if not EarnBatcher.ShouldRequeue(Status) then
		self.RefusedBatches += 1
		self.RefusedCoins += Flush.Coins
		return "Refused", nil
	end
	local Attempts = Flush.Attempts + 1
	if Attempts >= self.Policy.MaxAttempts then
		CountDropped(self, Flush)
		return "GaveUp", nil
	end
	local Wait = self.Retry.DelayFor(self.Policy, Attempts, self.RandomUnit(), RetryAfter)
	local Again = table.clone(Flush)
	Again.Attempts = Attempts
	Again.NextAttemptAt = if IsFinite(Now) then Now + math.max(Wait, self.Policy.BaseDelay) else 0
	local Evicted: Flush? = nil
	if #self.Retries >= self.MaxRetries then
		Evicted = table.remove(self.Retries, 1)
		CountDropped(self, Evicted :: Flush)
	end
	table.insert(self.Retries, Again)
	return "Queued", Evicted
end

function EarnBatcher.PendingCoins(self: EarnBatcher, UserId: number): number
	local Entry: Pending? = self.Pending[UserId]
	return if Entry then Entry.Coins else 0
end

function EarnBatcher.RetryCount(self: EarnBatcher): number
	return #self.Retries
end

-- How many batches, and how many Coins in them, were dropped since the last call.
function EarnBatcher.TakeDropped(self: EarnBatcher): (number, number)
	local Batches, Coins = self.DroppedBatches, self.DroppedCoins
	self.DroppedBatches = 0
	self.DroppedCoins = 0
	return Batches, Coins
end

-- How many batches the backend refused, and how many Coins in them, since the last call.
function EarnBatcher.TakeRefused(self: EarnBatcher): (number, number)
	local Batches, Coins = self.RefusedBatches, self.RefusedCoins
	self.RefusedBatches = 0
	self.RefusedCoins = 0
	return Batches, Coins
end

-- How many adds were refused, and how many Coins they tried to add, since the last call.
-- Only amounts that are real positive numbers go into the Coins count.
function EarnBatcher.TakeRejected(self: EarnBatcher): (number, number)
	local Adds, Coins = self.RejectedAdds, self.RejectedCoins
	self.RejectedAdds = 0
	self.RejectedCoins = 0
	return Adds, Coins
end

-- No answer, a refusal made on this server (an open breaker, the budget, or RetryLater), a
-- timeout, a throttle or a server error are all temporary. So are 401 and 403, because they are
-- about this server's credential and not the batch, and the attempt cap still ends them.
-- Any other answer, such as 400, 404, 409 or 422, is final and never sent again.
function EarnBatcher.ShouldRequeue(Status: number): boolean
	return Status <= 0
		or Status == 401
		or Status == 403
		or Status == 408
		or Status == 425
		or Status == 429
		or Status >= 500
end

return EarnBatcher
