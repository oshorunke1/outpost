--!strict
-- TelemetryBuffer holds events until TelemetryService sends them in batches.
-- It never grows past Capacity. When it is full the oldest event is dropped to make room, because
-- telemetry is allowed to lose data and the game must never stall on it.
-- It is a ring buffer, so pushing and taking never shift the whole list.
-- Every event is cleaned on the way in against the backend's allow lists, which the caller passes
-- in as a Schema (Configs/Telemetry in game). One bad value would make the backend refuse the
-- whole batch, so a bad event is thrown away here and counted instead.

export type Event = {
	name: string,
	ts: number,
	userId: number?,
	value: number?,
	dims: { [string]: string }?,
}

export type Schema = {
	EventNames: { string },
	DimValues: { [string]: { string } },
	DimFallbacks: { [string]: string },
	MaxEventsPerBatch: number,
	MaxBodyBytes: number,
}

type Fields = {
	Capacity: number,
	Schema: Schema,
	Items: { [number]: Event },
	Head: number,
	Size: number,
	Dropped: number,
	Rejected: number,
}

local TelemetryBuffer = {}
TelemetryBuffer.__index = TelemetryBuffer

export type TelemetryBuffer = typeof(setmetatable({} :: Fields, TelemetryBuffer))

-- The biggest whole number a JSON number holds exactly, and the backend's limit for ids and times.
local MaxSafeInteger = 9007199254740991

-- Any ts below this is too small to be Unix milliseconds. It is year 2001, and a time in plain
-- seconds is far below it, so a seconds clock passed by mistake is caught here.
local MinTimestampMillis = 1e12

-- The backend's limit on value, in either direction.
local MaxValue = 1e9

-- The bytes the body adds around the list, which is the events key with its quotes and brackets.
local BodyOverheadBytes = 13

local function IsWhole(Value: any, Low: number, High: number): boolean
	return type(Value) == "number" and Value == Value and Value % 1 == 0 and Value >= Low and Value <= High
end

function TelemetryBuffer.new(Capacity: number, Schema: Schema): TelemetryBuffer
	if not IsWhole(Capacity, 1, math.huge) or Capacity == math.huge then
		error(`TelemetryBuffer needs a whole Capacity of at least 1, got {Capacity}`, 2)
	end
	local Object: Fields = {
		Capacity = Capacity,
		Schema = Schema,
		Items = {},
		Head = 1,
		Size = 0,
		Dropped = 0,
		Rejected = 0,
	}
	return setmetatable(Object, TelemetryBuffer)
end

-- Keeps only dims the backend allows. An unknown key is dropped. A bad value is swapped for the
-- key's fallback when it has one (packet becomes Unknown), and otherwise just that dim is dropped.
-- Gives nil when nothing is left, so the event simply goes without dims.
function TelemetryBuffer.CleanDims(Dims: { [string]: string }?, Schema: Schema): { [string]: string }?
	if type(Dims) ~= "table" then
		return nil
	end
	local Clean: { [string]: string } = {}
	local Any = false
	for Key, Value in Dims do
		local Allowed = if type(Key) == "string" then Schema.DimValues[Key] else nil
		if Allowed == nil then
			continue
		end
		local Kept: string? = if type(Value) == "string" and table.find(Allowed, Value) ~= nil
			then Value
			else Schema.DimFallbacks[Key]
		if Kept ~= nil then
			Clean[Key] = Kept
			Any = true
		end
	end
	return if Any then Clean else nil
end

-- Builds a fresh event with only the fields the backend knows, or gives nil when the name, time,
-- userId or value would make the backend refuse it.
function TelemetryBuffer.CleanEvent(Event: any, Schema: Schema): Event?
	if type(Event) ~= "table" then
		return nil
	end
	local Name = Event.name
	if type(Name) ~= "string" or table.find(Schema.EventNames, Name) == nil then
		return nil
	end
	if not IsWhole(Event.ts, MinTimestampMillis, MaxSafeInteger) then
		return nil
	end
	local UserId = Event.userId
	if UserId ~= nil and not IsWhole(UserId, 1, MaxSafeInteger) then
		return nil
	end
	local Value = Event.value
	if Value ~= nil and (type(Value) ~= "number" or Value ~= Value or Value < -MaxValue or Value > MaxValue) then
		return nil
	end
	return {
		name = Name,
		ts = Event.ts,
		userId = UserId,
		value = Value,
		dims = TelemetryBuffer.CleanDims(Event.dims, Schema),
	}
end

-- Cleans the event and queues it. Gives false, and counts it, when the event had to be thrown away.
function TelemetryBuffer.Push(self: TelemetryBuffer, Event: any): boolean
	local Clean = TelemetryBuffer.CleanEvent(Event, self.Schema)
	if Clean == nil then
		self.Rejected += 1
		return false
	end
	if self.Size == self.Capacity then
		self.Items[self.Head] = nil
		self.Head = self.Head % self.Capacity + 1
		self.Size -= 1
		self.Dropped += 1
	end
	local Slot = (self.Head + self.Size - 1) % self.Capacity + 1
	self.Items[Slot] = Clean
	self.Size += 1
	return true
end

local function PopOldest(self: TelemetryBuffer): Event
	local Event = self.Items[self.Head]
	self.Items[self.Head] = nil
	self.Head = self.Head % self.Capacity + 1
	self.Size -= 1
	return Event
end

-- Takes up to Max of the oldest events, and never more than the backend takes in one batch.
function TelemetryBuffer.Take(self: TelemetryBuffer, Max: number): { Event }
	local Limit = math.min(Max, self.Schema.MaxEventsPerBatch)
	local Taken: { Event } = {}
	while self.Size > 0 and #Taken < Limit do
		table.insert(Taken, PopOldest(self))
	end
	return Taken
end

-- Takes the oldest events that fit in one request, both by count and by body size.
-- SizeOf gives the encoded byte length of one event, in game that is the length of its JSON.
-- An event that could never fit even on its own is thrown away and counted, so it can't block the rest.
function TelemetryBuffer.TakeBatch(self: TelemetryBuffer, SizeOf: (Event) -> number): { Event }
	local Taken: { Event } = {}
	local Bytes = BodyOverheadBytes
	while self.Size > 0 and #Taken < self.Schema.MaxEventsPerBatch do
		local Next = self.Items[self.Head]
		local Size = SizeOf(Next)
		if BodyOverheadBytes + Size > self.Schema.MaxBodyBytes then
			PopOldest(self)
			self.Rejected += 1
			continue
		end
		local Separator = if #Taken > 0 then 1 else 0
		if Bytes + Separator + Size > self.Schema.MaxBodyBytes then
			break
		end
		Bytes += Separator + Size
		table.insert(Taken, PopOldest(self))
	end
	return Taken
end

function TelemetryBuffer.Count(self: TelemetryBuffer): number
	return self.Size
end

-- How many events were pushed out by newer ones since the last call.
function TelemetryBuffer.TakeDropped(self: TelemetryBuffer): number
	local Dropped = self.Dropped
	self.Dropped = 0
	return Dropped
end

-- How many events were thrown away as ones the backend would refuse since the last call.
function TelemetryBuffer.TakeRejected(self: TelemetryBuffer): number
	local Rejected = self.Rejected
	self.Rejected = 0
	return Rejected
end

return TelemetryBuffer
