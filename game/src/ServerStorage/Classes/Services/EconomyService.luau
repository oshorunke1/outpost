--!strict
-- EconomyService keeps every ledger player's Coins in the backend ledger instead of in their save.
-- The logic lives in Shared EconomyCore, where Lune tests it. This file only wires it to Roblox,
-- to players joining and leaving, to the save, and to the server shutting down.
-- It only runs on a server where Backend.EconomyLive is true. Anywhere else it does nothing and the
-- old DataStore Coins work as before. A player whose save already moved to the ledger gets a paused
-- economy there, see SaveGate.
-- On every join it retries the backend join until it lands, then grants any purchase the backend
-- says was never acknowledged, then credits any Coins the player saved before the ledger existed.
-- The balance shown on screen is a cache. The backend's numbers always win.
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerStorage = game:GetService("ServerStorage")

local Shared = ReplicatedStorage.Shared
local EarnBatcher = require(Shared.Logic.Backend.EarnBatcher)
local PurchaseFlow = require(Shared.Logic.Backend.PurchaseFlow)
local Requests = require(Shared.Logic.Backend.Requests)
local RetryPolicy = require(Shared.Logic.Backend.RetryPolicy)
local EconomyCore = require(Shared.Logic.Economy.EconomyCore)
local JoinLoop = require(Shared.Logic.Economy.JoinLoop)
local LegacyCredit = require(Shared.Logic.Economy.LegacyCredit)
local PurchaseGuard = require(Shared.Logic.Economy.PurchaseGuard)
local ItemId = require(Shared.Enums.ItemId)
local BackendConfig = require(ServerStorage.Configs.Backend)
local Backend = require(ServerStorage.Classes.Util.Backend)
local DataService = require(ServerStorage.Classes.Services.DataService)

local TickSeconds = 1
local BatchCoins = 200
local BatchAgeSeconds = 30
-- How long the legacy credit waits for the save that holds LegacyCoins to be written.
local SaveNowSeconds = 30
-- Roblox gives BindToClose about 30 seconds. Every batch goes at once inside the window the
-- economy shares with telemetry, see Configs/Backend.
local ShutdownSeconds = BackendConfig.ShutdownSeconds
-- After a player leaves, Coins held for a join that never landed wait this long before they are given up.
local LeftJoinSeconds = 600

local EconomyService = {}
EconomyService.Priority = 20

local Rng = Random.new()
local Core: EconomyCore.EconomyCore? = nil
local Loops: JoinLoop.JoinLoop? = nil

local function Warn(Message: string)
	warn(`[EconomyService] {Message}`)
end

local function LoadedPlayer(UserId: number): Player?
	local Player = Players:GetPlayerByUserId(UserId)
	if Player ~= nil and DataService:EconomyFor(Player) == "Ledger" then
		return Player
	end
	return nil
end

local function OwnedFor(UserId: number): { [string]: boolean }?
	local Player = LoadedPlayer(UserId)
	local Data = if Player then DataService:GetData(Player) else nil
	return if Data then Data.OwnedItems else nil
end

local function GrantFor(UserId: number, Items: { string }): boolean
	local Player = LoadedPlayer(UserId)
	if Player == nil then
		return false
	end
	local Saved = DataService:Update(Player, function(Draft)
		for _, Id in Items do
			Draft.OwnedItems[Id] = true
		end
	end)
	return Saved
end

local function LegacyOwedFor(UserId: number): number?
	local Player = LoadedPlayer(UserId)
	local Data = if Player then DataService:GetData(Player) else nil
	return LegacyCredit.Owed(Data :: any)
end

local function MarkLegacyFor(UserId: number): boolean
	local Player = LoadedPlayer(UserId)
	if Player == nil then
		return false
	end
	local Saved = DataService:Update(Player, function(Draft)
		Draft.LegacyCredited = true
	end)
	return Saved
end

local function SaveNowFor(UserId: number): boolean
	local Player = LoadedPlayer(UserId)
	return Player ~= nil and DataService:SaveNow(Player, SaveNowSeconds)
end

local function PushFor(UserId: number)
	local Player = LoadedPlayer(UserId)
	if Player ~= nil then
		DataService:PushSnapshot(Player)
	end
end

-- Runs the join steps for the player's current visit, see Shared JoinLoop. A loop left over from
-- an earlier visit stops by itself, so it never gets in the way of this one.
local function RunJoin(UserId: number)
	local Running = Loops
	if Running ~= nil then
		Running:Run(UserId)
	end
end

local function OnProfileLoaded(Player: Player)
	local Running = Loops
	if Running ~= nil and DataService:EconomyFor(Player) == "Ledger" then
		Running:BeginVisit(Player.UserId)
		RunJoin(Player.UserId)
	end
end

-- DataService sets the ProfileLoaded attribute once the save is ready. Waiting on the attribute
-- works whether this runs before or after that happens.
local function WhenProfileLoaded(Player: Player)
	if Player:GetAttribute("ProfileLoaded") == true then
		task.spawn(OnProfileLoaded, Player)
		return
	end
	local Connection: RBXScriptConnection? = nil
	Connection = Player:GetAttributeChangedSignal("ProfileLoaded"):Connect(function()
		if Player:GetAttribute("ProfileLoaded") == true then
			if Connection ~= nil then
				Connection:Disconnect()
			end
			task.spawn(OnProfileLoaded, Player)
		end
	end)
end

local function OnPlayerRemoving(Player: Player)
	local Running = Core
	if Running == nil then
		return
	end
	local UserId = Player.UserId
	Running:Leave(UserId)
	if Running:IsJoined(UserId) then
		task.spawn(function()
			Backend.Client():Send(Requests.LeaveSession(UserId))
		end)
	end
end

-- Every batch goes out at once with one shared deadline, and whatever the backend never confirmed is warned about.
local function Shutdown()
	local Running = Core
	if Running == nil then
		return
	end
	local Started = os.clock()
	local All = Running:TakeEverything()
	local Left = #All
	for _, Flush in All do
		task.spawn(function()
			local Remaining = ShutdownSeconds - (os.clock() - Started)
			if Remaining > 0 then
				Running:Deliver(Flush, Remaining)
			end
			Left -= 1
		end)
	end
	while Left > 0 and os.clock() - Started < ShutdownSeconds do
		task.wait(0.1)
	end
	local Outstanding = Running:Outstanding()
	if Outstanding > 0 then
		Warn(`the server closed with {Outstanding} Coins the backend never confirmed`)
	end
end

function EconomyService:GetBalance(Player: Player): number
	local Running = Core
	return if Running then Running:Balance(Player.UserId) else 0
end

-- Shows the Coins at once and queues them for the backend. Only for a ledger player.
function EconomyService:Earn(Player: Player, Coins: number)
	local Running = Core
	if Running ~= nil and DataService:EconomyFor(Player) == "Ledger" then
		Running:Earn(Player.UserId, Coins)
	end
end

-- Buys an item through the ledger and yields while it does. A Grant is already in the save and
-- acknowledged by the time this returns. Anyone not on the ledger economy gets RetryLater.
function EconomyService:Purchase(Player: Player, Item: string): EconomyCore.Decision
	local Running = Core
	if Running == nil or DataService:EconomyFor(Player) ~= "Ledger" then
		return { Action = "RetryLater", Outcome = "Unavailable" }
	end
	return Running:Purchase(Player.UserId, Item)
end

-- Runs the join steps for a player again, the reconcile and the legacy credit. For an operator
-- who fixed a refused credit, or a Studio tester, from the server command bar.
function EconomyService:RunJoinSteps(Player: Player)
	local Running = Core
	if Running ~= nil and DataService:EconomyFor(Player) == "Ledger" then
		Running:ResetProgress(Player.UserId)
		task.spawn(RunJoin, Player.UserId)
	end
end

function EconomyService:Init()
	if not Backend.EconomyLive() then
		print("[EconomyService] the ledger economy is off on this server, Coins stay in the save")
		return
	end
	local Nonce = string.format("%08x", Rng:NextInteger(0, 0x7FFFFFFF))
	local Batcher = EarnBatcher.new({
		BootTag = Requests.BootTag(game.JobId, Nonce),
		MaxCoins = BatchCoins,
		MaxAgeSeconds = BatchAgeSeconds,
		Keys = Requests,
		Retry = RetryPolicy,
		Policy = EconomyCore.EarnRetryPolicy,
		RandomUnit = function()
			return Rng:NextNumber()
		end,
		MaxRetries = EconomyCore.MaxRetries,
	})
	local Guard = PurchaseGuard.new(function()
		return `buy-{HttpService:GenerateGUID(false)}`
	end)
	Core = EconomyCore.new({
		Client = Backend.Client(),
		Requests = Requests,
		PurchaseFlow = PurchaseFlow,
		LegacyCredit = LegacyCredit,
		Batcher = Batcher,
		Guard = Guard,
		ParseRetryAfter = RetryPolicy.ParseRetryAfter,
		ItemIds = ItemId,
		Save = {
			Owned = OwnedFor,
			Grant = GrantFor,
			LegacyOwed = LegacyOwedFor,
			MarkLegacy = MarkLegacyFor,
			SaveNow = SaveNowFor,
		},
		-- EarnBatcher and BackendClient both use os.clock, so the deadlines line up.
		Now = os.clock,
		Spawn = function(Work: () -> ())
			task.spawn(Work)
		end,
		Warn = Warn,
		Rejoin = function(UserId: number)
			task.spawn(RunJoin, UserId)
		end,
	})
	Loops = JoinLoop.new({
		Core = Core,
		IsHere = function(UserId: number)
			return LoadedPlayer(UserId) ~= nil
		end,
		Push = PushFor,
		Wait = function(Seconds: number)
			task.wait(Seconds)
		end,
		Now = os.clock,
		DelayFor = function(Attempt: number)
			return RetryPolicy.DelayFor(EconomyCore.JoinPolicy, Attempt, Rng:NextNumber())
		end,
		LeftJoinSeconds = LeftJoinSeconds,
		Warn = Warn,
	})
	DataService:SetCoinsSource(function(Player: Player)
		local Running = Core
		return EconomyService:GetBalance(Player), Running ~= nil and Running:IsJoined(Player.UserId)
	end)
	Players.PlayerAdded:Connect(WhenProfileLoaded)
	Players.PlayerRemoving:Connect(OnPlayerRemoving)
	for _, Player in Players:GetPlayers() do
		WhenProfileLoaded(Player)
	end
	game:BindToClose(Shutdown)
	print("[EconomyService] Coins live in the backend ledger on this server")
end

function EconomyService:Start()
	local Running = Core
	if Running == nil then
		return
	end
	while true do
		task.wait(TickSeconds)
		Running:Tick()
	end
end

return EconomyService
