--!strict
-- Server boot. Loads every service, runs all their Init functions, seals NetGuard so no new
-- listeners can sneak in later, then runs Start on each service in its own thread.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerStorage = game:GetService("ServerStorage")

local Loader = require(ReplicatedStorage.Shared.Util.Loader)
local NetGuard = require(ServerStorage.Classes.Util.NetGuard)

local Services = Loader.LoadFolders({ ServerStorage.Classes.Services })
local Ready = Loader.InitAll(Services)
NetGuard.Seal()
Loader.StartAll(Ready)

print(`[ServerStart] {#Ready} of {#Services} services ready`)
