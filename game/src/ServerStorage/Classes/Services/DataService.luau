--!strict
-- DataService loads each player's save with ProfileService and upgrades old saves with the Migrator.
-- Update is the only sanctioned way to change save data, and every Update is checked, so a change
-- that would put NaN or a function into the save is refused. GetData hands back the live table,
-- so code that writes to it directly skips that check. The release check is only a backstop.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local ServerStorage = game:GetService("ServerStorage")

local Shared = ReplicatedStorage.Shared
local Migrations = require(Shared.Logic.Data.Migrations)
local Migrator = require(Shared.Logic.Data.Migrator)
local Places = require(Shared.Configs.Places)
local SaveSafety = require(Shared.Logic.Data.SaveSafety)
local StoreSelector = require(Shared.Logic.Data.StoreSelector)
local Template = require(Shared.Logic.Data.Template)
local NetGuard = require(ServerStorage.Classes.Util.NetGuard)
local ProfileService = require(ServerStorage.Vendor.ProfileService) :: any

type ProfileData = Template.ProfileData

local DataService = {}
DataService.Priority = 10

local ActiveStore: any = nil
local Profiles: { [Player]: any } = {}
-- The last copy of each save that passed SaveSafety, used if something wrote bad data around Update.
local LastGood: { [Player]: { [string]: any } } = {}

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

	local Outcome = Migrator.Run(Profile.Data, Migrations)
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
		Player:Kick("Your save was opened somewhere else. Please rejoin.")
	end)

	if Player.Parent ~= Players then
		Profile:Release()
		return
	end

	Profiles[Player] = Profile
	LastGood[Player] = SaveSafety.DeepCopy(Profile.Data)
	Player:SetAttribute("ProfileLoaded", true)
	print(`[DataService] loaded {Player.Name} at schema v{Outcome.ToVersion} (from v{Outcome.FromVersion})`)
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
	Profile:Release()
	print(`[DataService] released {Player.Name}`)
end

function DataService:Init()
	local Choice = StoreSelector.Choose(
		game.PlaceId,
		RunService:IsStudio(),
		Places,
		ServerStorage:GetAttribute("ForceMockData") == true
	)
	local Store = ProfileService.GetProfileStore(Choice.StoreName, Template.Defaults)
	ActiveStore = if Choice.Kind == "Mock" then Store.Mock else Store
	print(`[DataService] using the {Choice.Kind} store {Choice.StoreName}`)

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
	NetGuard.SendTo(Player, "Profile.Snapshot", { Coins = Data.Coins, OwnedItems = Owned })
end

return DataService
