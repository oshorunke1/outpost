--!strict
-- OrbService spawns glowing orbs around the map and pays Coins when a player picks one up.
-- The client only says which orb it touched. The server checks the orb still exists, measures the
-- distance itself, and enforces a cooldown before paying anything.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerStorage = game:GetService("ServerStorage")

local OrbRules = require(ReplicatedStorage.Shared.Logic.Economy.OrbRules)
local Packets = require(ReplicatedStorage.Shared.Net.Packets)
local DataService = require(ServerStorage.Classes.Services.DataService)
local NetGuard = require(ServerStorage.Classes.Util.NetGuard)

local OrbCount = 12
local MinSpawnRadius = 8
local MaxSpawnRadius = 40
local RespawnSeconds = 3
-- The biggest OrbId the Orb.Collect packet accepts. Ids wrap back to 1 after it,
-- so new orbs stay collectable no matter how long the server runs.
local OrbIdCap: number = Packets.ByName["Orb.Collect"].Payload.Fields.OrbId.Max

local OrbService = {}

local OrbFolder: Folder? = nil
local Orbs: { [number]: BasePart? } = {}
local LastCollectAt: { [number]: number } = {}
local NextOrbId = 0
local Rng = Random.new()

local function SpawnOrb()
	local Folder = OrbFolder
	if Folder == nil then
		return
	end
	-- Count up and wrap at the cap, skipping any id an orb still holds.
	repeat
		NextOrbId = NextOrbId % OrbIdCap + 1
	until Orbs[NextOrbId] == nil
	local OrbId = NextOrbId
	local Angle = Rng:NextNumber(0, math.pi * 2)
	local Radius = Rng:NextNumber(MinSpawnRadius, MaxSpawnRadius)

	local Orb = Instance.new("Part")
	Orb.Name = `Orb{OrbId}`
	Orb.Shape = Enum.PartType.Ball
	Orb.Size = Vector3.new(2, 2, 2)
	Orb.Material = Enum.Material.Neon
	Orb.Color = Color3.fromRGB(255, 214, 64)
	Orb.Anchored = true
	Orb.CanCollide = false
	Orb.Position = Vector3.new(math.cos(Angle) * Radius, 3, math.sin(Angle) * Radius)
	Orb:SetAttribute("OrbId", OrbId)
	Orb.Parent = Folder
	Orbs[OrbId] = Orb
end

-- Measures from the player's root part to the orb. No character means an infinite distance,
-- which OrbRules always refuses.
local function DistanceTo(Player: Player, Orb: BasePart?): number
	local Character = Player.Character
	local Root = if Character then Character:FindFirstChild("HumanoidRootPart") else nil
	if Orb == nil or Root == nil or not Root:IsA("BasePart") then
		return math.huge
	end
	local RootPart = Root :: BasePart
	return (RootPart.Position - Orb.Position).Magnitude
end

local function OnCollect(Player: Player, Payload: { OrbId: number })
	if DataService:GetData(Player) == nil then
		return
	end
	local Orb = Orbs[Payload.OrbId]
	local Now = os.clock()
	local Allowed = OrbRules.CanCollect({
		OrbExists = Orb ~= nil,
		Distance = DistanceTo(Player, Orb),
		Now = Now,
		LastCollectAt = LastCollectAt[Player.UserId],
	})
	if not Allowed or Orb == nil then
		return
	end
	-- Take the orb away first, so a second request for the same orb finds nothing.
	Orbs[Payload.OrbId] = nil
	Orb:Destroy()
	LastCollectAt[Player.UserId] = Now

	local Paid = DataService:Update(Player, function(Data)
		Data.Coins += OrbRules.CoinsPerOrb
		Data.Stats.OrbsCollected += 1
	end)
	if Paid then
		DataService:PushSnapshot(Player)
	end
	task.delay(RespawnSeconds, SpawnOrb)
end

function OrbService:Init()
	local Folder = Instance.new("Folder")
	Folder.Name = "Orbs"
	Folder.Parent = workspace
	OrbFolder = Folder

	NetGuard.Listen("Orb.Collect", OnCollect)
	Players.PlayerRemoving:Connect(function(Player: Player)
		LastCollectAt[Player.UserId] = nil
	end)
end

function OrbService:Start()
	for _ = 1, OrbCount do
		SpawnOrb()
	end
end

return OrbService
