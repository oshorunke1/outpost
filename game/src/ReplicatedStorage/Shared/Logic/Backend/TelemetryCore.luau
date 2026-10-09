--!strict
-- TelemetryCore is everything TelemetryService does, kept free of game so Lune can test it.
-- Events wait in a TelemetryBuffer and go to the backend in batches. Telemetry fails open. A batch
-- the backend never took is dropped and warned about, never resent, so an outage costs some events
-- and never piles up work or makes the game wait.
-- An Offline server queues nothing at all, and the TelemetryEnabled flag turned off stops tracking.
-- The health events only ever carry names and values from the backend's allow lists. A packet
-- name that is not a real packet becomes Unknown, so nothing a player typed reaches the backend.
-- Nothing here touches game. The buffer, client, clocks and size function are passed in.

export type Schema = {
	EventNames: { string },
	DimValues: { [string]: { string } },
	DimFallbacks: { [string]: string },
	MaxEventsPerBatch: number,
	MaxBodyBytes: number,
}

export type Deps = {
	Schema: Schema, -- Configs/Telemetry in game
	Buffer: any, -- a TelemetryBuffer made with the same Schema
	Client: any, -- a BackendClient
	Batch: (Events: { any }) -> any, -- Requests.TelemetryBatch in game
	-- Unix milliseconds for each event's ts. DateTime.now().UnixTimestampMillis in game.
	NowMillis: () -> number,
	-- Seconds on the same clock BackendClient uses, for the shutdown deadline. os.clock in game.
	Now: () -> number,
	-- The encoded size of one event in bytes, the length of its JSON in game.
	SizeOf: (Event: any) -> number,
	-- The TelemetryEnabled flag.
	Enabled: () -> boolean,
	-- False on an Offline server.
	Live: boolean,
	Warn: (Message: string) -> (),
}

export type FlushResult = "Sent" | "Lost" | "Empty"

type Fields = {
	Deps: Deps,
	LastBreakerState: string,
	-- When the current NetGuard window started, how many drops it took and how many it skipped.
	DropWindowStart: number,
	DropsInWindow: number,
	DropsSkipped: number,
}

local TelemetryCore = {}
TelemetryCore.__index = TelemetryCore

export type TelemetryCore = typeof(setmetatable({} :: Fields, TelemetryCore))

-- NetGuard already logs each player's drops at most once per packet every 5 seconds, but many
-- players together could still flood the buffer. So the whole server tracks at most this many
-- netguard_drop events in each window, and the rest are counted and warned about once.
TelemetryCore.MaxNetGuardDropsPerWindow = 50
TelemetryCore.NetGuardWindowSeconds = 10

function TelemetryCore.new(Deps: Deps): TelemetryCore
	local Object: Fields = {
		Deps = Deps,
		LastBreakerState = "Closed",
		DropWindowStart = -math.huge,
		DropsInWindow = 0,
		DropsSkipped = 0,
	}
	return setmetatable(Object, TelemetryCore)
end

-- Queues one event. It is cleaned against the allow lists on the way in, see TelemetryBuffer.
function TelemetryCore.Track(
	self: TelemetryCore,
	Name: string,
	UserId: number?,
	Value: number?,
	Dims: { [string]: string }?
)
	local Deps = self.Deps
	if not Deps.Live or not Deps.Enabled() then
		return
	end
	Deps.Buffer:Push({ name = Name, ts = Deps.NowMillis(), userId = UserId, value = Value, dims = Dims })
end

-- How many events are waiting to go out.
function TelemetryCore.Pending(self: TelemetryCore): number
	return self.Deps.Buffer:Count()
end

-- A packet NetGuard dropped and logged. Only a real packet name and a known reason are kept, and
-- only up to the server wide cap in each window.
function TelemetryCore.NetGuardDrop(self: TelemetryCore, UserId: number, PacketName: string, Reason: string)
	local Now = self.Deps.Now()
	if Now - self.DropWindowStart >= TelemetryCore.NetGuardWindowSeconds then
		if self.DropsSkipped > 0 then
			self.Deps.Warn(`skipped {self.DropsSkipped} netguard_drop events over the server wide cap`)
		end
		self.DropWindowStart = Now
		self.DropsInWindow = 0
		self.DropsSkipped = 0
	end
	if self.DropsInWindow >= TelemetryCore.MaxNetGuardDropsPerWindow then
		self.DropsSkipped += 1
		return
	end
	self.DropsInWindow += 1
	local Values = self.Deps.Schema.DimValues
	local Dims: { [string]: string } = {
		packet = if table.find(Values.packet, PacketName) ~= nil then PacketName else "Unknown",
	}
	if table.find(Values.reason, Reason) ~= nil then
		Dims.reason = Reason
	end
	self:Track("netguard_drop", UserId, nil, Dims)
end

-- Tracks the breaker state whenever it changes. Anything that is not a real state is ignored.
function TelemetryCore.NoteBreaker(self: TelemetryCore, State: string)
	if State == self.LastBreakerState or table.find(self.Deps.Schema.DimValues.state, State) == nil then
		return
	end
	self.LastBreakerState = State
	self:Track("breaker_state", nil, nil, { state = State })
end

-- Warns about events the buffer threw away since the last call.
local function WarnLosses(self: TelemetryCore)
	local Deps = self.Deps
	local Rejected = Deps.Buffer:TakeRejected()
	if Rejected > 0 then
		Deps.Warn(`threw away {Rejected} telemetry events the backend would refuse`)
	end
	local Dropped = Deps.Buffer:TakeDropped()
	if Dropped > 0 then
		Deps.Warn(`the buffer was full, dropped {Dropped} telemetry events`)
	end
end

-- Sends the oldest events that fit in one request, giving the call DeadlineSeconds in total.
function TelemetryCore.Flush(self: TelemetryCore, DeadlineSeconds: number): FlushResult
	local Deps = self.Deps
	-- A size function that throws must not break the batch, so that event counts as too big.
	local Events = Deps.Buffer:TakeBatch(function(Event: any): number
		local Measured, Size = pcall(Deps.SizeOf, Event)
		return if Measured and type(Size) == "number" then Size else math.huge
	end)
	WarnLosses(self)
	if #Events == 0 then
		return "Empty"
	end
	local Sent, Response = pcall(function()
		return Deps.Client:Send(Deps.Batch(Events), { DeadlineSeconds = DeadlineSeconds })
	end)
	local Status = if Sent and type(Response) == "table" then Response.Status else nil
	if Status ~= 202 then
		Deps.Warn(`lost a telemetry batch of {#Events} events, status {Status}`)
		return "Lost"
	end
	local Body = Response.Body
	local Dropped = if type(Body) == "table" then Body.dropped else nil
	if type(Dropped) == "number" and Dropped > 0 then
		Deps.Warn(`the backend dropped {Dropped} of {#Events} telemetry events`)
	end
	return "Sent"
end

-- Sends batch after batch until the buffer is empty or Seconds are up. For the server shutting down.
function TelemetryCore.FlushAll(self: TelemetryCore, Seconds: number)
	local Deps = self.Deps
	local Deadline = Deps.Now() + Seconds
	while self:Pending() > 0 do
		local Left = Deadline - Deps.Now()
		if Left <= 0 then
			break
		end
		self:Flush(Left)
	end
end

return TelemetryCore
