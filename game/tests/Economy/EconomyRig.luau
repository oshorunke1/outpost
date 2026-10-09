--!strict
-- A whole EconomyCore wired to MockTransport through a real BackendClient, EarnBatcher and
-- PurchaseGuard, with a fake clock, in-memory saves and Spawn as a plain call. The EconomyCore
-- specs share it. Sends records every request the client put on the wire.
local BackendClient = require("@Logic/Backend/BackendClient")
local CircuitBreaker = require("@Logic/Backend/CircuitBreaker")
local EarnBatcher = require("@Logic/Backend/EarnBatcher")
local MockTransport = require("@Logic/Backend/MockTransport")
local PurchaseFlow = require("@Logic/Backend/PurchaseFlow")
local Requests = require("@Logic/Backend/Requests")
local RetryPolicy = require("@Logic/Backend/RetryPolicy")
local EconomyCore = require("@Logic/Economy/EconomyCore")
local LegacyCredit = require("@Logic/Economy/LegacyCredit")
local PurchaseGuard = require("@Logic/Economy/PurchaseGuard")
local RateLimiter = require("@Logic/Net/RateLimiter")
local Flags = require("@Configs/Flags")
local Shop = require("@Configs/Shop")
local Telemetry = require("@Configs/Telemetry")
local ItemId = require("@Shared/Enums/ItemId")

export type Save = { OwnedItems: { [string]: boolean }, LegacyCoins: number?, LegacyCredited: boolean? }

local EconomyRig = {}

EconomyRig.BootTag = "boot-0badf00d"

function EconomyRig.new(Options: { Intercept: ((Request: any) -> any?)? }?)
	local Given = Options or {}
	local Clock = { Now = 0 }
	local Transport, Controls = MockTransport.new(Shop, Flags :: any, Telemetry, function()
		return 1700000000000
	end)
	local Rig: any = {
		Clock = Clock,
		Controls = Controls,
		Sends = {},
		Warnings = {},
		Rejoins = {},
		Saves = {} :: { [number]: Save },
		AutoRejoin = false,
		FailGrant = false,
		FailMark = false,
		FailSaveNow = false,
		SaveNowCalls = 0,
		KeyCount = 0,
	}
	local function Recording(Request: any): any
		table.insert(Rig.Sends, Request)
		local Faked = if Given.Intercept then Given.Intercept(Request) else nil
		if Faked ~= nil then
			return Faked
		end
		return Transport(Request)
	end
	local Client = BackendClient.new({
		BaseUrl = "http://mock",
		Transport = Recording,
		ApiKeyHeader = "ApiKey mock",
		Now = function()
			return Clock.Now
		end,
		Sleep = function(Seconds: number)
			Clock.Now += Seconds
		end,
		RandomUnit = function()
			return 0
		end,
		Retry = RetryPolicy,
		Policy = RetryPolicy.Default,
		Breakers = {
			Auth = CircuitBreaker.new(5, 30),
			Economy = CircuitBreaker.new(50, 30),
			Telemetry = CircuitBreaker.new(5, 30),
			Flags = CircuitBreaker.new(5, 30),
		},
		Budget = RateLimiter.new(10000, 10000),
	})
	local Batcher = EarnBatcher.new({
		BootTag = EconomyRig.BootTag,
		MaxCoins = 200,
		MaxAgeSeconds = 30,
		Keys = Requests,
		Retry = RetryPolicy,
		Policy = EconomyCore.EarnRetryPolicy,
		RandomUnit = function()
			return 0
		end,
		MaxRetries = EconomyCore.MaxRetries,
	})
	local Guard = PurchaseGuard.new(function()
		Rig.KeyCount += 1
		return `buy-key-{Rig.KeyCount}`
	end)
	local Core
	Core = EconomyCore.new({
		Client = Client,
		Requests = Requests,
		PurchaseFlow = PurchaseFlow,
		LegacyCredit = LegacyCredit,
		Batcher = Batcher,
		Guard = Guard,
		ParseRetryAfter = RetryPolicy.ParseRetryAfter,
		ItemIds = ItemId,
		Save = {
			Owned = function(UserId: number)
				local Save = Rig.Saves[UserId]
				return if Save then Save.OwnedItems else nil
			end,
			Grant = function(UserId: number, Items: { string })
				local Save = Rig.Saves[UserId]
				if Save == nil or Rig.FailGrant then
					return false
				end
				for _, Id in Items do
					Save.OwnedItems[Id] = true
				end
				return true
			end,
			LegacyOwed = function(UserId: number)
				return LegacyCredit.Owed(Rig.Saves[UserId] :: any)
			end,
			MarkLegacy = function(UserId: number)
				local Save = Rig.Saves[UserId]
				if Save == nil or Rig.FailMark then
					return false
				end
				Save.LegacyCredited = true
				return true
			end,
			SaveNow = function(_UserId: number)
				Rig.SaveNowCalls += 1
				return not Rig.FailSaveNow
			end,
		},
		Now = function()
			return Clock.Now
		end,
		Spawn = function(Work: () -> ())
			Work()
		end,
		Warn = function(Message: string)
			table.insert(Rig.Warnings, Message)
		end,
		Rejoin = function(UserId: number)
			table.insert(Rig.Rejoins, UserId)
			if Rig.AutoRejoin then
				Core:Join(UserId)
			end
		end,
	})
	Rig.Core = Core
	Rig.Client = Client
	Rig.Batcher = Batcher
	Rig.Guard = Guard

	-- The player's real balance in the mock's ledger, or nil when the mock never saw them join.
	function Rig.Wallet(UserId: number): number?
		local Response = Client:Send(Requests.Wallet(UserId))
		return if Response.Status == 200 then Response.Body.balance else nil
	end

	-- Every request of one kind that went on the wire, in order. Kind is earn, legacy, purchase,
	-- join, fulfilled or unfulfilled.
	function Rig.Sent(Kind: string): { any }
		local Found = {}
		for _, Request in Rig.Sends do
			local Body = Request.Body
			local Url: string = Request.Url
			local Match = false
			if Kind == "earn" or Kind == "legacy" or Kind == "purchase" then
				local Reason = if Kind == "legacy" then "legacy_migration" else "orbs"
				Match = type(Body) == "table"
					and string.find(Url, "/v1/economy/transactions", 1, true) ~= nil
					and (
						if Kind == "purchase"
							then Body.kind == "purchase"
							else Body.kind == "earn" and Body.reason == Reason
					)
			elseif Kind == "join" then
				Match = string.match(Url, "/sessions$") ~= nil
			elseif Kind == "fulfilled" then
				Match = string.match(Url, "/fulfilled$") ~= nil
			elseif Kind == "unfulfilled" then
				Match = string.find(Url, "unfulfilled=1", 1, true) ~= nil
			end
			if Match then
				table.insert(Found, Request)
			end
		end
		return Found
	end

	-- The Idempotency-Key of each request of one kind.
	function Rig.Keys(Kind: string): { string }
		local Keys = {}
		for _, Request in Rig.Sent(Kind) do
			table.insert(Keys, Request.Headers["Idempotency-Key"])
		end
		return Keys
	end

	-- A loaded save for UserId, joined to the backend unless Joined is false.
	function Rig.Player(UserId: number, Save: Save?, Joined: boolean?)
		Rig.Saves[UserId] = Save or { OwnedItems = {} }
		if Joined ~= false then
			assert(Core:Join(UserId), "the join should land")
		end
	end

	return Rig
end

return EconomyRig
