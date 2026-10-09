--!strict
-- EconomyCore is everything EconomyService does with Coins, kept free of game so Lune can test it.
-- Coins live in the backend ledger. The save never holds them on a ledger server.
--
-- Earning. Orb Coins add up in an EarnBatcher and go out as idempotent earn batches. A batch for a
-- player whose join has not landed is held here, never sent, and goes out with its own key once
-- the join lands. A 404 on an earn means the backend lost track of the join, so the batch is held
-- again with the same key and the player joins again. Other temporary failures go back to the
-- batcher with the same key. A batch only ever lives in one place, the batcher, the held list or
-- one send, and every key is unique, so a batch can never be paid twice.
--
-- Buying. Only one purchase, reconcile or legacy credit runs per player at a time, see PurchaseGuard,
-- and no purchase runs before the join reconcile has finished.
-- A purchase sends the player's unsent Coins first, then buys with the key PurchaseGuard keeps for
-- that item until a definite answer, all inside one 10 second deadline. A Grant writes the item into
-- the save and acknowledges it only once a confirmed save holds it. Until then the purchase stays
-- unacknowledged, and the reconcile on the next join grants it.
--
-- Legacy credit. Coins a player saved before the ledger are credited once in fixed chunks, see
-- LegacyCredit. The save that holds them is written to the DataStore first, so the amount can never
-- change between tries. The save is marked only after every chunk is paid, and a crash in between
-- just replays the same keys.
--
-- The balance shown on screen is the last balance the backend gave plus the Coins not yet confirmed.
-- The backend's numbers always win.

export type Response = { Ok: boolean, Status: number, Body: any, Headers: { [string]: string } }
export type Flush = { UserId: number, Coins: number, Key: string, Attempts: number, NextAttemptAt: number }
export type Decision = {
	Action: "Grant" | "Refuse" | "RetryLater",
	Outcome: string,
	TransactionId: string?,
	BalanceAfter: number?,
}
export type LegacyResult = "Done" | "Nothing" | "RetryLater" | "Refused"

export type SaveHooks = {
	-- The items in the player's save, or nil when it is not loaded.
	Owned: (UserId: number) -> { [string]: boolean }?,
	-- Writes the items into the save. True when the write went in.
	Grant: (UserId: number, Items: { string }) -> boolean,
	-- The LegacyCoins still owed, see LegacyCredit.Owed.
	LegacyOwed: (UserId: number) -> number?,
	-- Sets LegacyCredited in the save. True when the write went in.
	MarkLegacy: (UserId: number) -> boolean,
	-- Writes the save to the DataStore now and waits. True when it landed.
	SaveNow: (UserId: number) -> boolean,
}

export type Deps = {
	Client: any, -- a BackendClient
	Requests: any, -- the Requests module
	PurchaseFlow: any,
	LegacyCredit: any,
	Batcher: any, -- an EarnBatcher made with EarnRetryPolicy and MaxRetries
	Guard: any, -- a PurchaseGuard
	ParseRetryAfter: (Value: string?) -> number?,
	ItemIds: { [string]: string },
	Save: SaveHooks,
	Now: () -> number,
	-- Runs Work on its own thread. task.spawn in game, a plain call in the specs.
	Spawn: (Work: () -> ()) -> (),
	Warn: (Message: string) -> (),
	-- Asks for the player's join to run again, because the backend did not know them.
	Rejoin: (UserId: number) -> (),
}

type Progress = { Reconciled: boolean, Legacy: boolean }

type Fields = {
	Deps: Deps,
	Joined: { [number]: boolean },
	Known: { [number]: number },
	Unconfirmed: { [number]: number },
	Held: { Flush },
	Progress: { [number]: Progress },
	FinalBatches: number,
	FinalCoins: number,
}

local EconomyCore = {}
EconomyCore.__index = EconomyCore

export type EconomyCore = typeof(setmetatable({} :: Fields, EconomyCore))

-- BackendClient.Unencodable. The body could not be made into JSON, so sending it again is pointless.
EconomyCore.Unencodable = -4

-- How long one join may take before the join loop waits and tries again.
EconomyCore.JoinDeadlineSeconds = 15

-- Earn batches ride out a long outage. Forty tries with waits growing to two minutes is well over
-- half an hour, and the retry list is big enough for every player of a full server for that long.
EconomyCore.EarnRetryPolicy = table.freeze({ MaxAttempts = 40, BaseDelay = 5, MaxDelay = 120 })
EconomyCore.MaxRetries = 5000

-- The waits between join tries, and between tries of the reconcile and legacy credit after it.
EconomyCore.JoinPolicy = table.freeze({ MaxAttempts = 1000000, BaseDelay = 2, MaxDelay = 60 })

-- The most one orb pickup or reward can add, the same cap EarnBatcher uses.
local MaxCoinsPerEarn = 100000

local function IsWhole(Value: any, Low: number, High: number): boolean
	return type(Value) == "number" and Value == Value and Value % 1 == 0 and Value >= Low and Value <= High
end

local function NoAnswer(): Response
	return { Ok = false, Status = 0, Body = nil, Headers = {} }
end

local function RetryLater(): Decision
	return { Action = "RetryLater", Outcome = "Unavailable" }
end

function EconomyCore.new(Deps: Deps): EconomyCore
	local Object: Fields = {
		Deps = Deps,
		Joined = {},
		Known = {},
		Unconfirmed = {},
		Held = {},
		Progress = {},
		FinalBatches = 0,
		FinalCoins = 0,
	}
	return setmetatable(Object, EconomyCore)
end

-- Builds a request and sends it. A builder that throws gives nil and the reason, and nothing is
-- sent. A client that throws counts as no answer.
local function Send(self: EconomyCore, Build: () -> any, Options: any?): (Response?, string?)
	local Built, Request = pcall(Build)
	if not Built then
		return nil, tostring(Request)
	end
	local Sent, Result = pcall(function()
		return self.Deps.Client:Send(Request, Options)
	end)
	if not Sent or type(Result) ~= "table" or type(Result.Status) ~= "number" then
		return NoAnswer(), nil
	end
	if type(Result.Headers) ~= "table" then
		Result.Headers = {}
	end
	return Result, nil
end

-- Takes Coins off the unconfirmed count once their batch is settled one way or the other.
local function Confirm(self: EconomyCore, UserId: number, Coins: number)
	local Left = (self.Unconfirmed[UserId] or 0) - Coins
	if Left > 0 then
		self.Unconfirmed[UserId] = Left
	else
		self.Unconfirmed[UserId] = nil
	end
end

-- A batch that can never be sent. It is counted for Tick to warn about, and never tried again.
local function Final(self: EconomyCore, Flush: Flush, Why: string)
	self.FinalBatches += 1
	self.FinalCoins += Flush.Coins
	Confirm(self, Flush.UserId, Flush.Coins)
	self.Deps.Warn(`earn batch {Flush.Key} for {Flush.UserId} can never be sent, {Why}`)
end

local function BalanceFrom(self: EconomyCore, UserId: number, Response: Response)
	local Body = Response.Body
	if Response.Status == 201 and type(Body) == "table" and IsWhole(Body.balanceAfter, 0, math.huge) then
		self.Known[UserId] = Body.balanceAfter
	end
end

-- Sends one earn batch, or holds it while the player's join has not landed. Gives back what
-- happened to it, Accepted, Held, Queued, Refused or GaveUp.
function EconomyCore.SendFlush(self: EconomyCore, Flush: Flush, DeadlineSeconds: number?): string
	local Deps = self.Deps
	local UserId = Flush.UserId
	if not self.Joined[UserId] then
		table.insert(self.Held, Flush)
		return "Held"
	end
	local Options = if DeadlineSeconds ~= nil then { DeadlineSeconds = DeadlineSeconds } else nil
	local Response, Problem = Send(self, function()
		return Deps.Requests.Earn(UserId, Flush.Coins, Flush.Key)
	end, Options)
	if Response == nil then
		Final(self, Flush, `the request could not be built, {Problem}`)
		return "Refused"
	end
	local Status = Response.Status
	if Status >= 200 and Status < 300 then
		Confirm(self, UserId, Flush.Coins)
		BalanceFrom(self, UserId, Response)
		return "Accepted"
	end
	if Status == 404 then
		-- The backend does not know the player. Hold the batch with its key and join again.
		self.Joined[UserId] = nil
		table.insert(self.Held, Flush)
		Deps.Rejoin(UserId)
		return "Held"
	end
	if Status == EconomyCore.Unencodable then
		Final(self, Flush, "its body would not encode")
		return "Refused"
	end
	local RetryAfter = Deps.ParseRetryAfter(Response.Headers["retry-after"])
	local Outcome, Evicted = Deps.Batcher:Requeue(Flush, Status, Deps.Now(), RetryAfter)
	if Outcome == "Refused" or Outcome == "GaveUp" then
		Confirm(self, UserId, Flush.Coins)
	end
	if Evicted ~= nil then
		Confirm(self, Evicted.UserId, Evicted.Coins)
	end
	return Outcome
end

local function TakeHeld(self: EconomyCore, UserId: number?): { Flush }
	local Taken: { Flush } = {}
	local Kept: { Flush } = {}
	for _, Flush in self.Held do
		table.insert(if UserId == nil or Flush.UserId == UserId then Taken else Kept, Flush)
	end
	self.Held = Kept
	return Taken
end

-- Joins the player to the backend. When it lands, every batch held for them goes out.
function EconomyCore.Join(self: EconomyCore, UserId: number, DeadlineSeconds: number?): boolean
	local Deps = self.Deps
	local Response = Send(self, function()
		return Deps.Requests.JoinSession(UserId)
	end, { DeadlineSeconds = DeadlineSeconds or EconomyCore.JoinDeadlineSeconds })
	local Body = if Response then Response.Body else nil
	if
		Response == nil
		or Response.Status ~= 200
		or type(Body) ~= "table"
		or not IsWhole(Body.balance, 0, math.huge)
	then
		return false
	end
	self.Joined[UserId] = true
	self.Known[UserId] = Body.balance
	for _, Flush in TakeHeld(self, UserId) do
		Deps.Spawn(function()
			self:SendFlush(Flush)
		end)
	end
	return true
end

function EconomyCore.IsJoined(self: EconomyCore, UserId: number): boolean
	return self.Joined[UserId] == true
end

-- Shows the Coins at once and queues them for the backend.
function EconomyCore.Earn(self: EconomyCore, UserId: number, Coins: number)
	local Deps = self.Deps
	local Batcher = Deps.Batcher
	local Ready: { Flush } = Batcher:Add(UserId, Coins, Deps.Now())
	-- The batcher refuses and counts a bad add, so only a good one is shown.
	if IsWhole(Coins, 1, MaxCoinsPerEarn) and IsWhole(UserId, 1, math.huge) then
		self.Unconfirmed[UserId] = (self.Unconfirmed[UserId] or 0) + Coins
	end
	for _, Flush in Ready do
		Deps.Spawn(function()
			self:SendFlush(Flush)
		end)
	end
end

-- The balance to show. The last one the backend gave, plus the Coins not confirmed yet.
function EconomyCore.Balance(self: EconomyCore, UserId: number): number
	return (self.Known[UserId] or 0) + (self.Unconfirmed[UserId] or 0)
end

-- Tells the backend the item is in the save. Safe to repeat. A failure, a throw included, is
-- simply left for the reconcile on the next join.
function EconomyCore.Acknowledge(self: EconomyCore, TransactionId: string): boolean
	local Deps = self.Deps
	local Response, Problem = Send(self, function()
		return Deps.Requests.Fulfilled(TransactionId)
	end)
	if Response == nil then
		Deps.Warn(`could not acknowledge {TransactionId}, {Problem}`)
		return false
	end
	return Response.Status >= 200 and Response.Status < 300
end

-- Acknowledges purchases only once a confirmed save holds their items. Save.Grant only changes
-- the save in memory, and a crash, a DataStore outage or another server taking the save could
-- still lose that. An unacknowledged purchase stays on the backend's unfulfilled list, so the
-- next join's reconcile grants it again. Granting is safe to repeat, an owned item is skipped.
function EconomyCore.AcknowledgeWhenSaved(self: EconomyCore, UserId: number, TransactionIds: { string }): boolean
	if #TransactionIds == 0 then
		return true
	end
	local Deps = self.Deps
	if not Deps.Save.SaveNow(UserId) then
		Deps.Warn(`the save for {UserId} was not confirmed, {#TransactionIds} purchases wait for the next join`)
		return false
	end
	for _, TransactionId in TransactionIds do
		self:Acknowledge(TransactionId)
	end
	return true
end

-- Runs Work while holding the player's lock. Nil when someone else holds it.
local function WithLock(self: EconomyCore, UserId: number, Work: () -> any): (boolean, any)
	local Guard = self.Deps.Guard
	if not Guard:TryLock(UserId) then
		return false, nil
	end
	local Ran, Result = pcall(Work)
	Guard:Unlock(UserId)
	if not Ran then
		self.Deps.Warn(`a locked step for {UserId} threw, {Result}`)
		return false, nil
	end
	return true, Result
end

-- Grants every purchase the backend says was never acknowledged, then acknowledges them.
-- True when that is done. False means try again later.
function EconomyCore.Reconcile(self: EconomyCore, UserId: number): boolean
	local Deps = self.Deps
	local Ran, Result = WithLock(self, UserId, function()
		local Response = Send(self, function()
			return Deps.Requests.Unfulfilled(UserId)
		end)
		local Owned = Deps.Save.Owned(UserId)
		if Response == nil or Response.Status ~= 200 or type(Response.Body) ~= "table" or Owned == nil then
			return false
		end
		local Plan = Deps.PurchaseFlow.ReconcilePlan(Response.Body.purchases, Owned, Deps.ItemIds)
		if #Plan.Grant > 0 and not Deps.Save.Grant(UserId, Plan.Grant) then
			return false
		end
		Deps.Spawn(function()
			self:AcknowledgeWhenSaved(UserId, Plan.Ack)
		end)
		return true
	end)
	return Ran and Result == true
end

local function Buy(self: EconomyCore, UserId: number, ItemId: string): Decision
	local Deps = self.Deps
	local Owned = Deps.Save.Owned(UserId)
	if Owned == nil then
		return { Action = "Refuse", Outcome = "Unavailable" }
	end
	if Owned[ItemId] then
		return { Action = "Refuse", Outcome = "AlreadyOwned" }
	end
	local Seconds = Deps.PurchaseFlow.DeadlineSeconds
	local Deadline = Deps.Now() + Seconds
	-- Send the unsent Coins first, so the backend sees the balance the player sees.
	local Pending = Deps.Batcher:TakeFor(UserId)
	if Pending ~= nil then
		self:SendFlush(Pending, Seconds)
	end
	local Key = Deps.Guard:KeyFor(UserId, ItemId)
	local Decision: Decision =
		Deps.PurchaseFlow.Submit(Deps.Client, Deps.Requests, UserId, ItemId, Key, Deadline - Deps.Now())
	Deps.Guard:Settle(UserId, ItemId, Decision.Action)
	local TransactionId = Decision.TransactionId
	if Decision.Action ~= "Grant" or TransactionId == nil then
		return Decision
	end
	if Decision.BalanceAfter ~= nil then
		self.Known[UserId] = Decision.BalanceAfter
	end
	if not Deps.Save.Grant(UserId, { ItemId }) then
		Deps.Warn(`{UserId} paid for {ItemId} but the save refused it, the next join grants it`)
		return { Action = "Grant", Outcome = "Unavailable", TransactionId = TransactionId }
	end
	Deps.Spawn(function()
		self:AcknowledgeWhenSaved(UserId, { TransactionId })
	end)
	return Decision
end

-- Buys an item through the ledger and yields while it does. A player whose join has not landed,
-- whose join reconcile has not finished, or who already has something running, gets RetryLater
-- and nothing is sent. Waiting for the reconcile matters. An item a crashed server charged for is
-- not in the save until the reconcile grants it, so buying it before then would charge twice.
function EconomyCore.Purchase(self: EconomyCore, UserId: number, ItemId: string): Decision
	local Progress = self.Progress[UserId]
	if not self.Joined[UserId] or Progress == nil or not Progress.Reconciled then
		return RetryLater()
	end
	local Ran, Result = WithLock(self, UserId, function()
		return Buy(self, UserId, ItemId)
	end)
	return if Ran then Result else RetryLater()
end

local function Credit(self: EconomyCore, UserId: number, Owed: number): LegacyResult
	local Deps = self.Deps
	-- The save holding LegacyCoins must be stored first. Otherwise a crash could bring back the old
	-- save, it could earn more on a server without the ledger, and the same keys would then carry
	-- different amounts.
	if not Deps.Save.SaveNow(UserId) then
		return "RetryLater"
	end
	for Index, Coins in Deps.LegacyCredit.Chunks(Owed) do
		local Response, Problem = Send(self, function()
			return Deps.Requests.LegacyCredit(UserId, Coins, Index)
		end)
		if Response == nil then
			Deps.Warn(`the legacy credit for {UserId} could not be built, {Problem}`)
			return "Refused"
		end
		local Verdict = Deps.LegacyCredit.Classify(Response.Status)
		if Verdict == "Rejoin" then
			self.Joined[UserId] = nil
			Deps.Rejoin(UserId)
			return "RetryLater"
		elseif Verdict == "Later" then
			return "RetryLater"
		elseif Verdict == "Refused" then
			Deps.Warn(
				`the backend refused legacy chunk {Index} for {UserId} with {Response.Status}, left for an operator`
			)
			return "Refused"
		end
		BalanceFrom(self, UserId, Response)
	end
	if not Deps.Save.MarkLegacy(UserId) then
		return "RetryLater"
	end
	-- Replays carry the balance from their first time, so ask for the real one.
	local Wallet = Send(self, function()
		return Deps.Requests.Wallet(UserId)
	end)
	if
		Wallet ~= nil
		and Wallet.Status == 200
		and type(Wallet.Body) == "table"
		and IsWhole(Wallet.Body.balance, 0, math.huge)
	then
		self.Known[UserId] = Wallet.Body.balance
	end
	return "Done"
end

-- Credits the player's LegacyCoins once. Done, Nothing to credit, RetryLater, or Refused, which is
-- warned about and left in the save for an operator.
function EconomyCore.CreditLegacy(self: EconomyCore, UserId: number): LegacyResult
	local Deps = self.Deps
	local Owed = Deps.Save.LegacyOwed(UserId)
	if Owed == nil then
		return "Nothing"
	end
	if Owed > Deps.LegacyCredit.MaxCoins then
		Deps.Warn(`{UserId} has {Owed} legacy Coins, over the {Deps.LegacyCredit.MaxCoins} cap, left for an operator`)
		return "Refused"
	end
	if not self.Joined[UserId] then
		return "RetryLater"
	end
	local Ran, Result = WithLock(self, UserId, function()
		return Credit(self, UserId, Owed)
	end)
	return if Ran then Result else "RetryLater"
end

-- The steps after a join, the reconcile and then the legacy credit, each run until it is settled.
-- True once both are. A refused legacy credit counts as settled for this visit.
function EconomyCore.AfterJoin(self: EconomyCore, UserId: number): boolean
	if not self.Joined[UserId] then
		return false
	end
	local Progress = self.Progress[UserId]
	if Progress == nil then
		Progress = { Reconciled = false, Legacy = false }
		self.Progress[UserId] = Progress
	end
	if not Progress.Reconciled then
		Progress.Reconciled = self:Reconcile(UserId)
	end
	if Progress.Reconciled and not Progress.Legacy then
		Progress.Legacy = self:CreditLegacy(UserId) ~= "RetryLater"
	end
	return Progress.Reconciled and Progress.Legacy
end

-- A new visit starts. The player joins the backend again, which fetches their balance, and the
-- steps after the join run again. This happens when they arrive, not when they leave, because
-- batches still retrying after a leave need the old join to keep going.
function EconomyCore.BeginVisit(self: EconomyCore, UserId: number)
	self.Joined[UserId] = nil
	self.Progress[UserId] = nil
	self.Known[UserId] = nil
end

-- Forgets that the steps after the join were settled, so the next AfterJoin runs them again.
-- For an operator who fixed a refused legacy credit, or a Studio tester.
function EconomyCore.ResetProgress(self: EconomyCore, UserId: number)
	self.Progress[UserId] = nil
end

-- The player left. Their waiting Coins go out now, and a running purchase keeps its lock and key.
function EconomyCore.Leave(self: EconomyCore, UserId: number)
	local Deps = self.Deps
	Deps.Guard:Forget(UserId)
	self.Progress[UserId] = nil
	self.Known[UserId] = nil
	local Pending = Deps.Batcher:TakeFor(UserId)
	if Pending ~= nil then
		Deps.Spawn(function()
			self:SendFlush(Pending)
		end)
	end
end

-- Coins held for a player whose join never landed.
function EconomyCore.HeldCoins(self: EconomyCore, UserId: number): number
	local Total = 0
	for _, Flush in self.Held do
		if Flush.UserId == UserId then
			Total += Flush.Coins
		end
	end
	return Total
end

-- Gives up on the Coins held for a player whose join never landed, warns, and hands back the total.
function EconomyCore.DropHeld(self: EconomyCore, UserId: number): number
	local Total = 0
	for _, Flush in TakeHeld(self, UserId) do
		Total += Flush.Coins
		Confirm(self, UserId, Flush.Coins)
	end
	if Total > 0 then
		self.Deps.Warn(`gave up on {Total} Coins for {UserId}, the backend never took their join`)
	end
	return Total
end

-- Sends every batch whose time has come, then warns about anything refused or dropped since the last tick.
function EconomyCore.Tick(self: EconomyCore)
	local Deps = self.Deps
	local Batcher = Deps.Batcher
	for _, Flush in Batcher:TakeDue(Deps.Now()) do
		Deps.Spawn(function()
			self:SendFlush(Flush)
		end)
	end
	local Adds, AddCoins = Batcher:TakeRejected()
	if Adds > 0 then
		Deps.Warn(`refused {Adds} earns worth {AddCoins} Coins before batching`)
	end
	local Refused, RefusedCoins = Batcher:TakeRefused()
	if Refused > 0 then
		Deps.Warn(`the backend refused {Refused} earn batches worth {RefusedCoins} Coins`)
	end
	local Dropped, DroppedCoins = Batcher:TakeDropped()
	if Dropped > 0 then
		Deps.Warn(`gave up on {Dropped} earn batches worth {DroppedCoins} Coins after too many tries`)
	end
	if self.FinalBatches > 0 then
		Deps.Warn(`{self.FinalBatches} earn batches worth {self.FinalCoins} Coins could never be sent`)
		self.FinalBatches = 0
		self.FinalCoins = 0
	end
end

-- The server is shutting down. Every batch, waiting, retrying or held, comes out to be sent now.
function EconomyCore.TakeEverything(self: EconomyCore): { Flush }
	local All: { Flush } = self.Deps.Batcher:TakeAll()
	for _, Flush in TakeHeld(self, nil) do
		table.insert(All, Flush)
	end
	return All
end

-- Sends one batch within Seconds, joining the player first when their join never landed.
function EconomyCore.Deliver(self: EconomyCore, Flush: Flush, Seconds: number): string
	if not self.Joined[Flush.UserId] then
		self:Join(Flush.UserId, Seconds)
	end
	return self:SendFlush(Flush, Seconds)
end

-- Every Coin earned on this server that the backend has not confirmed yet.
function EconomyCore.Outstanding(self: EconomyCore): number
	local Total = 0
	for _, Coins in self.Unconfirmed do
		Total += Coins
	end
	return Total
end

return EconomyCore
