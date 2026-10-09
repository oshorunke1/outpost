--!strict
-- TelemetryService collects gameplay and health events and sends them to the backend in batches
-- every 10 seconds. Telemetry fails open. A batch the backend never took is dropped, and when events
-- pile up faster than they go out the oldest are dropped, so the game never waits on it.
-- It tracks player_join, player_leave, breaker_state and netguard_drop itself. Other services call
-- Track. An Offline server tracks nothing. The logic is in Shared TelemetryCore.
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerStorage = game:GetService("ServerStorage")

local Shared = ReplicatedStorage.Shared
local Telemetry = require(Shared.Configs.Telemetry)
local Requests = require(Shared.Logic.Backend.Requests)
local TelemetryBuffer = require(Shared.Logic.Backend.TelemetryBuffer)
local TelemetryCore = require(Shared.Logic.Backend.TelemetryCore)
local BackendConfig = require(ServerStorage.Configs.Backend)
local Backend = require(ServerStorage.Classes.Util.Backend)
local NetGuard = require(ServerStorage.Classes.Util.NetGuard)
local FlagService = require(ServerStorage.Classes.Services.FlagService)

local SendEverySeconds = 10
-- One batch gets this long, so a slow backend never stacks sends on top of each other.
local SendDeadlineSeconds = 10
-- Ten full batches, about a minute and a half of a busy server.
local BufferSize = 5000

local TelemetryService = {}
TelemetryService.Priority = 16

local Core: TelemetryCore.TelemetryCore? = nil

local function Warn(Message: string)
	warn(`[TelemetryService] {Message}`)
end

local function SizeOf(Event: any): number
	return #HttpService:JSONEncode(Event)
end

-- Queues one event. Does nothing before Init or on an Offline server. Never waits.
function TelemetryService:Track(Name: string, UserId: number?, Value: number?, Dims: { [string]: string }?)
	local Running = Core
	if Running ~= nil then
		Running:Track(Name, UserId, Value, Dims)
	end
end

local function NoteBreaker(Running: TelemetryCore.TelemetryCore)
	Running:NoteBreaker(Backend.Client():BreakerState())
end

-- The server is closing. This runs next to the economy's own BindToClose, at the same time, and
-- shares its window, so the two together stay inside the time Roblox gives.
local function Shutdown()
	local Running = Core
	if Running ~= nil then
		NoteBreaker(Running)
		Running:FlushAll(BackendConfig.ShutdownSeconds)
	end
end

function TelemetryService:Init()
	local Running = TelemetryCore.new({
		Schema = Telemetry,
		Buffer = TelemetryBuffer.new(BufferSize, Telemetry),
		Client = Backend.Client(),
		Batch = Requests.TelemetryBatch,
		NowMillis = function()
			return DateTime.now().UnixTimestampMillis
		end,
		-- BackendClient uses os.clock too, so the shutdown deadline lines up with its own.
		Now = os.clock,
		SizeOf = SizeOf,
		Enabled = function()
			return FlagService:Value("TelemetryEnabled") ~= false
		end,
		Live = Backend.Mode() ~= "Offline",
		Warn = Warn,
	})
	Core = Running
	Players.PlayerAdded:Connect(function(Player: Player)
		Running:PlayerJoined(Player.UserId)
	end)
	Players.PlayerRemoving:Connect(function(Player: Player)
		Running:PlayerLeft(Player.UserId)
	end)
	-- Players who got in before this service started still count as joined. One that PlayerAdded
	-- also reports is only tracked once.
	for _, Player in Players:GetPlayers() do
		Running:PlayerJoined(Player.UserId)
	end
	NetGuard.SetDropObserver(function(Player: Player, PacketName: string, Reason: string)
		Running:NetGuardDrop(Player.UserId, PacketName, Reason)
	end)
	game:BindToClose(Shutdown)
end

function TelemetryService:Start()
	local Running = Core
	if Running == nil then
		return
	end
	while true do
		task.wait(SendEverySeconds)
		NoteBreaker(Running)
		Running:Flush(SendDeadlineSeconds)
	end
end

return TelemetryService
