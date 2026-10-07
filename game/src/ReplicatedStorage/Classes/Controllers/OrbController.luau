--!strict
-- OrbController notices when the local character touches an orb and asks the server to collect it.
-- The server decides whether the pickup counts. This only sends the request, once per orb at a time.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local NetClient = require(ReplicatedStorage.Classes.Util.NetClient)

local RetryAfterSeconds = 1

local OrbController = {}

local Pending: { [number]: boolean } = {}

local function WatchCharacter(Character: Model, OrbFolder: Instance)
	local Root = Character:WaitForChild("HumanoidRootPart", 10)
	if Root == nil or not Root:IsA("BasePart") then
		return
	end
	local RootPart = Root :: BasePart
	RootPart.Touched:Connect(function(Hit: BasePart)
		if Hit.Parent ~= OrbFolder then
			return
		end
		local OrbId = Hit:GetAttribute("OrbId")
		if type(OrbId) ~= "number" or Pending[OrbId] then
			return
		end
		Pending[OrbId] = true
		NetClient.Fire("Orb.Collect", { OrbId = OrbId })
		-- If the server said no, for example during the cooldown, we can ask again a moment later.
		task.delay(RetryAfterSeconds, function()
			Pending[OrbId] = nil
		end)
	end)
end

function OrbController:Start()
	local OrbFolder = workspace:WaitForChild("Orbs")
	local Player = Players.LocalPlayer
	Player.CharacterAdded:Connect(function(Character: Model)
		WatchCharacter(Character, OrbFolder)
	end)
	local Current = Player.Character
	if Current then
		WatchCharacter(Current, OrbFolder)
	end
end

return OrbController
