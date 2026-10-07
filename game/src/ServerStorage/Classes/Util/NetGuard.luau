--!strict
-- NetGuard is the only way server code listens to remotes from players.
-- Services call Listen during Init. ServerStart calls Seal after every Init, which makes the
-- RemoteEvents and wires them up, and after that nobody can add a listener.
-- Every packet is rate limited per player and its payload is checked before any handler runs.
-- Handlers only ever trust the Player argument that Roblox hands them, never anything in the payload.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage.Shared
local ItemId = require(Shared.Enums.ItemId)
local PacketGate = require(Shared.Logic.Net.PacketGate)
local Packets = require(Shared.Net.Packets)
local RateLimiter = require(Shared.Logic.Net.RateLimiter)
local Validate = require(Shared.Logic.Net.Validate)

local LogEverySeconds = 5
local Enums = { ItemId = ItemId }

local function BuildEntries(): { [string]: PacketGate.Entry }
	local Entries: { [string]: PacketGate.Entry } = {}
	for _, Def in Packets.List do
		local Inbound = Def.Direction == "ClientToServer"
		local Limit = Def.RateLimit
		Entries[Def.Name] = {
			Direction = Def.Direction,
			Check = if Inbound then Validate.FromSpec(Def.Payload :: any, Enums) else nil,
			Limiter = if Inbound and Limit then RateLimiter.new(Limit.Capacity, Limit.RefillPerSecond) else nil,
		}
	end
	return Entries
end

local Gate = PacketGate.new(BuildEntries(), LogEverySeconds)
local Remotes: { [string]: RemoteEvent? } = {}

local NetGuard = {}

function NetGuard.Listen(Name: string, Handler: (Player: Player, Payload: any) -> ())
	Gate:Listen(Name, Handler)
end

function NetGuard.IsSealed(): boolean
	return Gate:IsSealed()
end

local function OnServerEvent(Name: string, Player: Player, ...: any)
	local ArgCount = select("#", ...)
	local Payload = (...)
	local Verdict = Gate:Admit(Player.UserId, Name, ArgCount, Payload, os.clock())
	if not Verdict.Accepted then
		if Verdict.ShouldLog then
			warn(`[NetGuard] dropped {Name} from {Player.Name} ({Player.UserId}), reason {Verdict.Reason}`)
		end
		return
	end
	local Handler = Gate:HandlerFor(Name)
	if Handler == nil then
		return
	end
	-- Each handler runs in its own thread, so one that errors or waits never blocks other packets.
	task.spawn(function()
		local Ok, Err = xpcall(Handler :: (any, any) -> any, debug.traceback, Player, Payload)
		if not Ok then
			warn(`[NetGuard] handler for {Name} failed, {Err}`)
		end
	end)
end

function NetGuard.Seal()
	Gate:Seal()
	local Folder = Instance.new("Folder")
	Folder.Name = "Remotes"
	for _, Def in Packets.List do
		local Remote = Instance.new("RemoteEvent")
		Remote.Name = Def.Name
		Remote.Parent = Folder
		Remotes[Def.Name] = Remote
		if Def.Direction == "ClientToServer" then
			local Name = Def.Name
			Remote.OnServerEvent:Connect(function(Player: Player, ...: any)
				OnServerEvent(Name, Player, ...)
			end)
		end
	end
	Folder.Parent = ReplicatedStorage
	Players.PlayerRemoving:Connect(function(Player: Player)
		Gate:Forget(Player.UserId)
	end)
end

function NetGuard.SendTo(Player: Player, Name: string, Payload: any)
	local Def = Packets.ByName[Name]
	if Def == nil or Def.Direction ~= "ServerToClient" then
		error(`{Name} is not a server to client packet`, 2)
	end
	local Remote = Remotes[Name]
	if Remote == nil then
		error("NetGuard.SendTo was called before Seal", 2)
	end
	Remote:FireClient(Player, Payload)
end

return NetGuard
