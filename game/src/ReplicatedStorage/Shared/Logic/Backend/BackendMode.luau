--!strict
-- BackendMode decides how a server reaches the backend.
-- Studio always uses MockTransport, because a Roblox server can't reach a backend on this machine.
-- A live server only talks to the backend when Configs/Backend has it turned on and the API key
-- secret is there. Otherwise it is Offline, sends nothing at all and refuses every call at once.
-- A live server is never put on the mock. The mock keeps wallets in memory, so Coins earned on it
-- would vanish when the server closes.
-- Nothing here touches game. Whether this is Studio and how to find the secret are passed in.

export type Mode = "Mock" | "Roblox" | "Offline"
-- Copies of the types in BackendClient, because Shared modules require nothing. Change them together.
export type Response = { Ok: boolean, Status: number, Body: any, Headers: { [string]: string } }
export type TransportRequest = {
	Method: string,
	Url: string,
	Headers: { [string]: any },
	Body: any?,
	TimeoutSeconds: number?,
}

local BackendMode = {}

-- The status an Offline server answers with. It matches BackendClient.Offline, and the spec checks.
-- It is below zero, so BackendClient never retries it and no breaker counts it.
BackendMode.OfflineStatus = -5

-- FindSecret is only called for a live server that is turned on, so Studio never touches secrets.
function BackendMode.Pick(IsStudio: boolean, Enabled: boolean, FindSecret: () -> boolean): Mode
	if IsStudio then
		return "Mock"
	end
	if not Enabled then
		return "Offline"
	end
	return if FindSecret() then "Roblox" else "Offline"
end

-- The transport an Offline server uses. Every call is refused at once and nothing is sent.
function BackendMode.Offline(_Request: TransportRequest): Response
	return { Ok = false, Status = BackendMode.OfflineStatus, Body = nil, Headers = {} }
end

return BackendMode
