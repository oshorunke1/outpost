--!strict
-- Where the game server finds the Outpost backend.
-- This sits in ServerStorage on purpose. Roblox never sends ServerStorage to players, so the
-- backend address and the name of the secret never reach a client.
-- Enabled stays false until a backend is deployed somewhere Roblox can reach, because Roblox
-- servers cannot call a backend on this machine. While it is false a published server sends
-- nothing and the game keeps its old DataStore Coins. Studio always uses MockTransport.
-- HttpBurst and HttpBudgetPerMinute together stay under Roblox's limit of 500 HttpService
-- requests a minute per server, with room left for anything else the game does.
-- StudioLedger lets Studio try the ledger economy on MockTransport. It also keeps every save in
-- memory while it is on, so a Studio run never touches a real DataStore. It does nothing live.
-- RequestTimeoutSeconds is how long one HTTP request may take before we stop waiting for it.
export type Backend = {
	Enabled: boolean,
	BaseUrl: string,
	SecretName: string,
	HttpBudgetPerMinute: number,
	HttpBurst: number,
	RequestTimeoutSeconds: number,
	StudioLedger: boolean,
}

local Backend: Backend = {
	Enabled = false,
	BaseUrl = "https://outpost-backend.invalid",
	SecretName = "OutpostApiKey",
	HttpBudgetPerMinute = 400,
	HttpBurst = 50,
	RequestTimeoutSeconds = 15,
	StudioLedger = false,
}

return table.freeze(Backend)
