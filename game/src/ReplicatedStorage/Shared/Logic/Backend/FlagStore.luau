--!strict
-- FlagStore keeps the feature flag values the game is using right now and refreshes them from the
-- backend when FlagService polls. It starts on the defaults in Configs/Flags and only ever changes
-- through FlagValues, so a flag keeps its last known value through an outage and a bad value goes
-- back to its default.
-- An Offline server never polls, so it runs on the defaults for its whole life.
-- Nothing here touches game. The client, the request builder and the merge are passed in.

export type Deps = {
	Defaults: any,
	-- FlagValues.FromResponse in game.
	FromResponse: (Defaults: any, Current: { [string]: any }, Response: any) -> { [string]: any },
	Client: any, -- a BackendClient
	Request: () -> any, -- Requests.Flags in game
	-- False on an Offline server, which sends nothing at all.
	Live: boolean,
}

type Fields = { Deps: Deps, Values: { [string]: any } }

local FlagStore = {}
FlagStore.__index = FlagStore

export type FlagStore = typeof(setmetatable({} :: Fields, FlagStore))

-- A poll gives up after this long. The next one is a minute away anyway.
FlagStore.DeadlineSeconds = 30

function FlagStore.new(Deps: Deps): FlagStore
	local Object: Fields = { Deps = Deps, Values = Deps.FromResponse(Deps.Defaults, {}, { Status = 0 }) }
	return setmetatable(Object, FlagStore)
end

-- The value of one flag, or nil for a flag the game does not know.
function FlagStore.Value(self: FlagStore, Key: string): any
	return self.Values[Key]
end

-- Asks the backend for the flags once. True when a good answer came back and was merged.
function FlagStore.Poll(self: FlagStore): boolean
	local Deps = self.Deps
	if not Deps.Live then
		return false
	end
	local Sent, Response = pcall(function()
		return Deps.Client:Send(Deps.Request(), { DeadlineSeconds = FlagStore.DeadlineSeconds })
	end)
	if not Sent or type(Response) ~= "table" then
		return false
	end
	self.Values = Deps.FromResponse(Deps.Defaults, self.Values, Response)
	return Response.Status == 200 and type(Response.Body) == "table" and type(Response.Body.flags) == "table"
end

return FlagStore
