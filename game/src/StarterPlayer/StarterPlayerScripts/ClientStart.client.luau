--!strict
-- Client boot. Waits for the game to finish loading, then loads every controller the same way
-- the server loads services. ADR 0003 explains why this lives in StarterPlayerScripts.
local ReplicatedStorage = game:GetService("ReplicatedStorage")

if not game:IsLoaded() then
	game.Loaded:Wait()
end

local Loader = require(ReplicatedStorage.Shared.Util.Loader)

local Controllers = Loader.LoadFolders({ ReplicatedStorage.Classes.Controllers })
local Ready = Loader.InitAll(Controllers)
Loader.StartAll(Ready)

print(`[ClientStart] {#Ready} of {#Controllers} controllers ready`)
