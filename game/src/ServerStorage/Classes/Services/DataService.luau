--!strict
-- DataService loads each player's save with ProfileService and upgrades old saves with the Migrator.
-- Update is the only sanctioned way to change save data, and every Update is checked, so a change
-- that would put NaN or a function into the save is refused. GetData hands back the live table,
-- so code that writes to it directly skips that check. The release check is only a backstop.
-- SaveGate decides how far each save is upgraded. Only a server that talks to the backend ledger
-- moves a save to version 2, where Coins live in the ledger. Any other server keeps the old
-- version 1 Coins, and a save that already moved is never taken back.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local ServerStorage = game:GetService("ServerStorage")

local Shared = ReplicatedStorage.Shared
local BackendMode = require(Shared.Logic.Backend.BackendMode)
local Migrations = require(Shared.Logic.Data.Migrations)
local Migrator = require(Shared.Logic.Data.Migrator)
local Places = require(Shared.Configs.Places)
local SaveSafety = require(Shared.Logic.Data.SaveSafety)
local SaveSeq = require(Shared.Logic.Data.SaveSeq)
local StoreSelector = require(Shared.Logic.Data.StoreSelector)
local SaveGate = require(Shared.Logic.Data.SaveGate)
local Template = require(Shared.Logic.Data.Template)
local Backend = require(ServerStorage.Classes.Util.Backend)
local BackendConfig = require(ServerStorage.Configs.Backend)
local NetGuard = require(ServerStorage.Classes.Util.NetGuard)
local ProfileService = require(ServerStorage.Vendor.ProfileService) :: any

type ProfileData = Template.ProfileData

local DataService = {}
DataService.Priority = 10

-- How often SaveNow asks ProfileService again while it waits.
local SaveAgainSeconds = 5

local ActiveStore: any = nil
local Profiles: { [Player]: any } = {}
-- The last copy of each save that passed SaveSafety, used if something wrote bad data around Update.
local LastGood: { [Player]: { [string]: any } } = {}
-- Which economy each loaded player has, see SaveGate.
local Economies: { [Player]: SaveGate.Economy } = {}
-- Set once in Init. True when this server keeps Coins in the backend ledger.
local EconomyLive = false

-- Coins live in the backend ledger from M2 on. EconomyService tells DataService where to read them
-- for the snapshot, so DataService never has to require EconomyService.
local CoinsSource: (Player: Player) -> number = function(_Player: Player)
	return 0
end

local function OnPlayerAdded(Player: Player)
	local LoadedEvent = Instance.new("BindableEvent")
	LoadedEvent.Name = "ProfileLoaded"
	LoadedEvent.Parent = Player

	local Profile = ActiveStore:LoadProfileAsync(`Player_{Player.UserId}`, "ForceLoad")
	if Profile == nil then
		Player:Kick("Your save could not be loaded. Please rejoin.")
		return
	end
	Profile:AddUserId(Player.UserId)

	local Outcome, Economy = SaveGate.Prepare(Profile.Data, Migrations, Migrator.Run, EconomyLive)
	if not Outcome.Ok then
		-- The original save is untouched, so releasing it here saves exactly what was there before.
		warn(`[DataService] could not upgrade the save for {Player.Name}, {Outcome.Error}`)
		Profile:Release()
		Player:Kick("Your save could not be upgraded. Please rejoin in a minute.")
		return
	end
	-- Keep the original so it can be put back if the upgraded save turns out to be unsafe.
	local Original = SaveSafety.DeepCopy(Profile.Data)
	SaveSafety.ReplaceContents(Profile.Data, Outcome.Data :: { [string]: any })
	Profile:Reconcile()
	SaveGate.Tidy(Profile.Data)
	local Safe, Problem = SaveSafety.Check(Profile.Data)
	if not Safe then
		warn(`[DataService] the upgraded save for {Player.Name} is unsafe ({Problem}), leaving it as it was`)
		SaveSafety.ReplaceContents(Profile.Data, Original)
		Profile:Release()
		Player:Kick("Your save could not be verified. Please rejoin in a minute.")
		return
	end

	Profile:ListenToRelease(function()
		Profiles[Player] = nil
		LastGood[Player] = nil
		Economies[Player] = nil
		Player:Kick("Your save was opened somewhere else. Please rejoin.")
	end)

	if Player.Parent ~= Players then
		Profile:Release()
		return
	end

	Profiles[Player] = Profile
	LastGood[Player] = SaveSafety.DeepCopy(Profile.Data)
	Economies[Player] = Economy :: SaveGate.Economy
	Player:SetAttribute("ProfileLoaded", true)
	print(
		`[DataService] loaded {Player.Name} at schema v{Outcome.ToVersion} (from v{Outcome.FromVersion}), {Economy} economy`
	)
	LoadedEvent:Fire()
	DataService:PushSnapshot(Player)
end

local function ReleaseSafely(Player: Player)
	local Profile = Profiles[Player]
	if Profile == nil then
		return
	end
	local Safe, Problem = SaveSafety.Check(Profile.Data)
	if not Safe then
		warn(`[DataService] {Player.Name} had unsafe data ({Problem}), saving the last good copy instead`)
		SaveSafety.ReplaceContents(Profile.Data, SaveSafety.DeepCopy(LastGood[Player]))
	end
	Profiles[Player] = nil
	Economies[Player] = nil
	Profile:Release()
	print(`[DataService] released {Player.Name}`)
end

function DataService:Init()
	local IsStudio = RunService:IsStudio()
	-- A Studio ledger run keeps saves in memory, so it never writes the real test store.
	local ForceMock = ServerStorage:GetAttribute("ForceMockData") == true
		or BackendMode.ForceMockSaves(IsStudio, BackendConfig.StudioLedger)
	local Choice = StoreSelector.Choose(game.PlaceId, IsStudio, Places, ForceMock)
	-- The gate is read once, so every save on this server goes the same way.
	EconomyLive = Backend.EconomyLive()
	local Store = ProfileService.GetProfileStore(Choice.StoreName, SaveGate.DefaultsFor(EconomyLive, Template))
	ActiveStore = if Choice.Kind == "Mock" then Store.Mock else Store
	print(`[DataService] using the {Choice.Kind} store {Choice.StoreName}, ledger economy {EconomyLive}`)

	NetGuard.Listen("Profile.RequestSnapshot", function(Player: Player)
		DataService:PushSnapshot(Player)
	end)

	Players.PlayerAdded:Connect(OnPlayerAdded)
	Players.PlayerRemoving:Connect(ReleaseSafely)
	-- On shutdown every profile gets the same check before it is released.
	game:BindToClose(function()
		for Player in Profiles do
			ReleaseSafely(Player)
		end
	end)
	-- Players who joined before this ran still need their saves loaded.
	for _, Player in Players:GetPlayers() do
		task.spawn(OnPlayerAdded, Player)
	end
end

function DataService:GetData(Player: Player): ProfileData?
	local Profile = Profiles[Player]
	return if Profile then Profile.Data else nil
end

function DataService:Update(Player: Player, Mutator: (Draft: ProfileData) -> ()): (boolean, string?)
	local Profile = Profiles[Player]
	if Profile == nil then
		return false, "no loaded profile"
	end
	local Ok, Problem = SaveSafety.TryUpdate(Profile.Data, Mutator)
	if not Ok then
		warn(`[DataService] refused an update for {Player.Name}, {Problem}`)
		return false, Problem
	end
	LastGood[Player] = SaveSafety.DeepCopy(Profile.Data)
	return true, nil
end

-- Ledger, Legacy or Paused once the save is loaded, and nil before that.
function DataService:EconomyFor(Player: Player): SaveGate.Economy?
	return Economies[Player]
end

function DataService:SetCoinsSource(Source: (Player: Player) -> number)
	CoinsSource = Source
end

-- Writes the save now and waits until that write lands, for at most TimeoutSeconds.
-- True means a DataStore save that read the data after this call began is stored, so everything
-- in the save at the moment of the call is durable. It uses a SaveSeq meta tag, so a save that
-- was already on its way, or an autosave of older data, never counts. False means it did not land
-- in time, or this server lost the save to another one.
function DataService:SaveNow(Player: Player, TimeoutSeconds: number): boolean
	local Profile = Profiles[Player]
	if Profile == nil then
		return false
	end
	local Wanted = SaveSeq.Next(Profile.MetaData.MetaTags)
	Profile:SetMetaTag(SaveSeq.Tag, Wanted)
	local Landed = false
	local Connection = Profile.MetaTagsUpdated:Connect(function(Latest)
		if SaveSeq.Landed(Latest, Wanted) then
			Landed = true
		end
	end)
	local Started = os.clock()
	local AskedAt = -math.huge
	while not Landed and Profiles[Player] == Profile and os.clock() - Started < TimeoutSeconds do
		-- Save ignores a call while another write is queued, so it is asked again now and then.
		if os.clock() - AskedAt >= SaveAgainSeconds then
			AskedAt = os.clock()
			Profile:Save()
		end
		task.wait(0.25)
	end
	Connection:Disconnect()
	return Landed and Profiles[Player] == Profile
end

function DataService:PushSnapshot(Player: Player)
	local Data = DataService:GetData(Player)
	if Data == nil or not NetGuard.IsSealed() then
		return
	end
	local Owned: { string } = {}
	for Id, IsOwned in Data.OwnedItems do
		if IsOwned then
			table.insert(Owned, Id)
		end
	end
	table.sort(Owned)
	-- A Legacy player still has Coins in the save. Everyone else reads them from the ledger cache.
	local Coins = if Economies[Player] == "Legacy" then Data.Coins or 0 else CoinsSource(Player)
	Coins = math.floor(Coins)
	if Coins ~= Coins then
		Coins = 0
	end
	NetGuard.SendTo(Player, "Profile.Snapshot", { Coins = math.clamp(Coins, 0, 1000000000), OwnedItems = Owned })
end

return DataService
