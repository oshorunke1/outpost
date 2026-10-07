--!strict
-- NetClient is how client code talks to the server. It only lets you fire packets the client is
-- allowed to send, and only listen to packets the server sends, so a typo fails loudly right away.
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Packets = require(ReplicatedStorage.Shared.Net.Packets)

local NetClient = {}

local function GetRemote(Name: string): RemoteEvent
	local Folder = ReplicatedStorage:WaitForChild("Remotes")
	return Folder:WaitForChild(Name) :: RemoteEvent
end

function NetClient.Fire(Name: string, Payload: any)
	local Def = Packets.ByName[Name]
	if Def == nil or Def.Direction ~= "ClientToServer" then
		error(`{Name} is not a client to server packet`, 2)
	end
	GetRemote(Name):FireServer(Payload)
end

function NetClient.On(Name: string, Callback: (Payload: any) -> ()): RBXScriptConnection
	local Def = Packets.ByName[Name]
	if Def == nil or Def.Direction ~= "ServerToClient" then
		error(`{Name} is not a server to client packet`, 2)
	end
	return GetRemote(Name).OnClientEvent:Connect(Callback)
end

return NetClient
