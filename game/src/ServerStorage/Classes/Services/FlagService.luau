--!strict
-- FlagService asks the backend for the feature flags once a minute and serves the last values it got.
-- Before the first answer, and for as long as the backend can't be reached, it serves the defaults
-- in Configs/Flags or the last good values, so a backend outage never changes how the game behaves.
-- An Offline server never asks and runs on the defaults. The logic is in Shared FlagStore.
-- The getter is called Value on purpose. The Loader skips any module with a Get function.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerStorage = game:GetService("ServerStorage")

local Shared = ReplicatedStorage.Shared
local FlagDefaults = require(Shared.Configs.Flags)
local FlagStore = require(Shared.Logic.Backend.FlagStore)
local FlagValues = require(Shared.Logic.Backend.FlagValues)
local Requests = require(Shared.Logic.Backend.Requests)
local Backend = require(ServerStorage.Classes.Util.Backend)

local PollSeconds = 60

local FlagService = {}
FlagService.Priority = 15

local Store: FlagStore.FlagStore? = nil

-- Builds the store the first time anyone asks, so a flag read during another service's Init works.
local function TheStore(): FlagStore.FlagStore
	local Existing = Store
	if Existing ~= nil then
		return Existing
	end
	local Created = FlagStore.new({
		Defaults = FlagDefaults,
		FromResponse = FlagValues.FromResponse,
		Client = Backend.Client(),
		Request = Requests.Flags,
		Live = Backend.Mode() ~= "Offline",
	})
	Store = Created
	return Created
end

-- The current value of one flag, see Configs/Flags for the names. Never waits.
function FlagService:Value(Key: string): any
	return TheStore():Value(Key)
end

function FlagService:Init()
	TheStore()
end

function FlagService:Start()
	local Running = TheStore()
	while true do
		Running:Poll()
		task.wait(PollSeconds)
	end
end

return FlagService
