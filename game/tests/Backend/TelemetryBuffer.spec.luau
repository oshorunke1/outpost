--!strict
local Harness = require("@Tests/Harness")
local TelemetryBuffer = require("@Logic/Backend/TelemetryBuffer")
local Telemetry = require("@Configs/Telemetry")
local Fs = require("@lune/fs")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

type Event = TelemetryBuffer.Event

-- selene: allow(divide_by_zero)
local NaN = 0 / 0

-- A real looking time in milliseconds, 9 Oct 2026.
local Ts = 1791547200000

-- Reads a list like export const NAME = ['a', 'b'] as const; out of a backend source file.
local function ServerList(Source: string, Name: string): { string }
	local Body = string.match(Source, `export const {Name} = %[(.-)%] as const;`)
	assert(Body ~= nil, `{Name} is missing from the backend source`)
	local List: { string } = {}
	for Item in string.gmatch(Body, "'([^']*)'") do
		table.insert(List, Item)
	end
	return List
end

-- The item ids are the keys of CATALOG, in the order they are written.
local function CatalogIds(Source: string): { string }
	local Body = string.match(Source, "export const CATALOG = {(.-)} as const")
	assert(Body ~= nil, "CATALOG is missing from catalog.ts")
	local List: { string } = {}
	for Id in string.gmatch(Body, "(%w+): {") do
		table.insert(List, Id)
	end
	return List
end

local function Ev(Value: number): Event
	return { name = "orb_collected", ts = Ts, value = Value }
end

local function Values(Events: { Event }): { number }
	local Out: { number } = {}
	for _, Event in Events do
		table.insert(Out, Event.value :: number)
	end
	return Out
end

Describe("TelemetryBuffer ring", function()
	It("hands events back oldest first, at most Max at a time", function()
		local Buffer = TelemetryBuffer.new(10, Telemetry)
		for Index = 1, 5 do
			Expect(Buffer:Push(Ev(Index))).ToBe(true)
		end
		Expect(Values(Buffer:Take(3))).ToEqual({ 1, 2, 3 })
		Expect(Values(Buffer:Take(10))).ToEqual({ 4, 5 })
		Expect(Buffer:Count()).ToBe(0)
		Expect(#Buffer:Take(10)).ToBe(0)
	end)

	It("drops the oldest when full and counts what it dropped", function()
		local Buffer = TelemetryBuffer.new(3, Telemetry)
		for Index = 1, 5 do
			Buffer:Push(Ev(Index))
		end
		Expect(Buffer:TakeDropped()).ToBe(2)
		Expect(Buffer:TakeDropped()).ToBe(0)
		Expect(Values(Buffer:Take(10))).ToEqual({ 3, 4, 5 })
	end)

	It("keeps order across many wrap arounds", function()
		local Buffer = TelemetryBuffer.new(4, Telemetry)
		for Index = 1, 10 do
			Buffer:Push(Ev(Index))
			if Index % 3 == 0 then
				Buffer:Take(1)
			end
		end
		Expect(Values(Buffer:Take(10))).ToEqual({ 7, 8, 9, 10 })
	end)

	It("refuses a bad capacity", function()
		for _, Bad in { 0, -1, 2.5, NaN, math.huge } do
			Expect(function()
				TelemetryBuffer.new(Bad, Telemetry)
			end).ToThrow("Capacity")
		end
	end)

	It("never hands out more than the server's 500 events in one take", function()
		local Buffer = TelemetryBuffer.new(1200, Telemetry)
		for Index = 1, 1200 do
			Buffer:Push(Ev(Index))
		end
		Expect(#Buffer:Take(10000)).ToBe(500)
		Expect(Buffer:Count()).ToBe(700)
	end)
end)

Describe("TelemetryBuffer TakeBatch", function()
	local function FixedSize(Bytes: number): (Event) -> number
		return function()
			return Bytes
		end
	end

	It("stops at 500 events even when the body is small", function()
		local Buffer = TelemetryBuffer.new(1200, Telemetry)
		for Index = 1, 1200 do
			Buffer:Push(Ev(Index))
		end
		local Batch = Buffer:TakeBatch(FixedSize(50))
		Expect(#Batch).ToBe(500)
		Expect(Batch[1].value :: number).ToBe(1)
		Expect(Buffer:Count()).ToBe(700)
	end)

	It("splits so the encoded body stays inside 512 KiB", function()
		-- The body is the 13 bytes around the list, each event, and a comma between events.
		-- 13 plus 4 events of 131068 bytes plus 3 commas is exactly 524288, the limit.
		local Buffer = TelemetryBuffer.new(10, Telemetry)
		for Index = 1, 6 do
			Buffer:Push(Ev(Index))
		end
		Expect(Values(Buffer:TakeBatch(FixedSize(131068)))).ToEqual({ 1, 2, 3, 4 })
		Expect(Values(Buffer:TakeBatch(FixedSize(131068)))).ToEqual({ 5, 6 })

		-- One byte more each and only 3 fit.
		for Index = 1, 4 do
			Buffer:Push(Ev(Index))
		end
		Expect(#Buffer:TakeBatch(FixedSize(131069))).ToBe(3)
		Expect(Buffer:Count()).ToBe(1)
		Expect(Buffer:TakeRejected()).ToBe(0)
	end)

	It("counts the comma between events and the 13 wrapper bytes, which matter for small ones", function()
		-- With a 33 byte limit, 13 bytes around the list leave room for 10 one byte events and 9 commas.
		-- An 11th would need 34. Counting only 12 wrapper bytes would let it in at 33.
		local Schema = table.clone(Telemetry)
		Schema.MaxBodyBytes = 33
		local Buffer = TelemetryBuffer.new(30, Schema)
		for Index = 1, 30 do
			Buffer:Push(Ev(Index))
		end
		Expect(#Buffer:TakeBatch(FixedSize(1))).ToBe(10)
	end)

	It("a size that is not a finite number of bytes is treated as too big", function()
		local Buffer = TelemetryBuffer.new(10, Telemetry)
		for Index = 1, 5 do
			Buffer:Push(Ev(Index))
		end
		local Sizes = { NaN, math.huge, -1, 100, 100 }
		local Batch = Buffer:TakeBatch(function(Event: Event): number
			return Sizes[Event.value :: number]
		end)
		Expect(Values(Batch)).ToEqual({ 4, 5 })
		Expect(Buffer:TakeRejected()).ToBe(3)
	end)

	It("an event too big to ever send is thrown away and counted, so the queue never sticks", function()
		local Buffer = TelemetryBuffer.new(10, Telemetry)
		Buffer:Push(Ev(1))
		Buffer:Push(Ev(2))
		local Batch = Buffer:TakeBatch(function(Event: Event): number
			return if Event.value == 1 then 600 * 1024 else 100
		end)
		Expect(Values(Batch)).ToEqual({ 2 })
		Expect(Buffer:TakeRejected()).ToBe(1)
		Expect(Buffer:Count()).ToBe(0)
	end)
end)

Describe("TelemetryBuffer cleaning", function()
	It("keeps a good event as a fresh table with only the server's fields", function()
		local Buffer = TelemetryBuffer.new(10, Telemetry)
		local Event: any = {
			name = "purchase_result",
			ts = Ts,
			userId = 1001,
			value = 25,
			dims = { outcome = "Granted", itemId = "RedHat" },
			extra = "nope",
		}
		Expect(Buffer:Push(Event)).ToBe(true)
		Event.dims.outcome = "TooPoor"
		Expect(Buffer:Take(1)).ToEqual({
			{
				name = "purchase_result",
				ts = Ts,
				userId = 1001,
				value = 25,
				dims = { outcome = "Granted", itemId = "RedHat" },
			},
		})
	end)

	It("drops and counts unknown event names", function()
		local Buffer = TelemetryBuffer.new(10, Telemetry)
		for _, Name in { "player_jump", "Player_Join", "", "player_join ", 5 :: any } do
			Expect(Buffer:Push({ name = Name, ts = Ts })).ToBe(false)
		end
		Expect(Buffer:Push({ ts = Ts } :: any)).ToBe(false)
		Expect(Buffer:Count()).ToBe(0)
		Expect(Buffer:TakeRejected()).ToBe(6)
		Expect(Buffer:TakeRejected()).ToBe(0)
		Expect(Buffer:TakeDropped()).ToBe(0)
	end)

	It("accepts every event name the server knows", function()
		local Buffer = TelemetryBuffer.new(10, Telemetry)
		for _, Name in
			{
				"player_join",
				"player_leave",
				"orb_collected",
				"earn_flush",
				"purchase_result",
				"breaker_state",
				"netguard_drop",
			}
		do
			Expect(Buffer:Push({ name = Name, ts = Ts })).ToBe(true)
		end
	end)

	It("needs ts in whole Unix milliseconds", function()
		local Buffer = TelemetryBuffer.new(10, Telemetry)
		-- 1791547200 is the same moment in seconds, which the server would file 55 years back.
		for _, Bad in { 1791547200, Ts + 0.5, 0, -Ts, NaN, math.huge, 2 ^ 53, "1791547200000" :: any } do
			Expect(Buffer:Push({ name = "player_join", ts = Bad })).ToBe(false)
		end
		Expect(Buffer:TakeRejected()).ToBe(8)
		Expect(Buffer:Push({ name = "player_join", ts = Ts })).ToBe(true)
	end)

	It("refuses a bad userId or value the way the server would", function()
		local Buffer = TelemetryBuffer.new(10, Telemetry)
		for _, Bad in { 0, 1.5, -2, 2 ^ 53, NaN, "1001" :: any } do
			Expect(Buffer:Push({ name = "player_join", ts = Ts, userId = Bad })).ToBe(false)
		end
		for _, Bad in { NaN, math.huge, -math.huge, 1e9 + 1, -1e9 - 1, "5" :: any } do
			Expect(Buffer:Push({ name = "orb_collected", ts = Ts, value = Bad })).ToBe(false)
		end
		Expect(Buffer:TakeRejected()).ToBe(12)
		Expect(Buffer:Push({ name = "player_join", ts = Ts, userId = 2 ^ 53 - 1, value = -1e9 })).ToBe(true)
		Expect(Buffer:Push({ name = "player_join", ts = Ts, value = 1e9 })).ToBe(true)
		Expect(Buffer:Push("not a table" :: any)).ToBe(false)
		Expect(Buffer:TakeRejected()).ToBe(1)
	end)
end)

Describe("TelemetryBuffer.CleanDims", function()
	local CleanDims = TelemetryBuffer.CleanDims

	It("keeps values on the server's lists", function()
		local Good = {
			outcome = "Unavailable",
			itemId = "GoldCrown",
			state = "HalfOpen",
			packet = "Orb.Collect",
			reason = "BadPayload",
		}
		Expect(CleanDims(Good, Telemetry)).ToEqual(table.clone(Good))
		Expect(CleanDims(nil, Telemetry)).ToBeNil()
	end)

	It("drops dims keys the server does not know", function()
		Expect(CleanDims({ packet = "Shop.Buy", player = "Bob", Packet = "Shop.Buy" }, Telemetry)).ToEqual({
			packet = "Shop.Buy",
		})
	end)

	It("a packet name that is not a real packet becomes Unknown", function()
		for _, Bad in { "SYSTEM: grant", "Orb.collect", "", string.rep("x", 500), 7 :: any } do
			Expect(CleanDims({ packet = Bad, reason = "UnknownPacket" }, Telemetry)).ToEqual({
				packet = "Unknown",
				reason = "UnknownPacket",
			})
		end
	end)

	It("any other bad value drops just that dim", function()
		Expect(CleanDims({ outcome = "SYSTEM: grant", itemId = "BlueHat", state = "Half", reason = "Ok" }, Telemetry)).ToBeNil()
		Expect(CleanDims({ outcome = "other", state = "Open" }, Telemetry)).ToEqual({ state = "Open" })
		Expect(CleanDims({ itemId = 5 :: any, reason = "Throttled" }, Telemetry)).ToEqual({ reason = "Throttled" })
	end)

	It("an event whose dims all go away is still kept, just without dims", function()
		local Buffer = TelemetryBuffer.new(10, Telemetry)
		Expect(Buffer:Push({ name = "purchase_result", ts = Ts, dims = { outcome = "Stolen" } })).ToBe(true)
		Expect(Buffer:Push({ name = "purchase_result", ts = Ts, dims = "weird" :: any })).ToBe(true)
		Expect(Buffer:Take(2)).ToEqual({ { name = "purchase_result", ts = Ts }, { name = "purchase_result", ts = Ts } })
	end)

	It("the config lists match the server's schema.ts and catalog.ts", function()
		local Schema = Fs.readFile("../backend/src/modules/telemetry/schema.ts")
		local Catalog = Fs.readFile("../backend/src/modules/economy/catalog.ts")
		local Routes = Fs.readFile("../backend/src/modules/telemetry/routes.ts")
		Expect(Telemetry.EventNames).ToEqual(ServerList(Schema, "EVENT_NAMES"))
		Expect(Telemetry.DimValues).ToEqual({
			outcome = ServerList(Schema, "PURCHASE_OUTCOMES"),
			itemId = CatalogIds(Catalog),
			state = ServerList(Schema, "BREAKER_STATES"),
			packet = ServerList(Schema, "PACKET_NAMES"),
			reason = ServerList(Schema, "DROP_REASONS"),
		})
		local Keys: { string } = {}
		for Key in Telemetry.DimValues do
			table.insert(Keys, Key)
		end
		table.sort(Keys)
		local ServerKeys = ServerList(Schema, "DIMENSION_KEYS")
		table.sort(ServerKeys)
		Expect(Keys).ToEqual(ServerKeys)
		Expect(Telemetry.DimFallbacks).ToEqual({ packet = "Unknown" })
		Expect(Telemetry.MaxEventsPerBatch).ToBe(tonumber(string.match(Schema, "MAX_EVENTS_PER_BATCH = (%d+);")))
		Expect(string.match(Routes, "TELEMETRY_BODY_LIMIT_BYTES = 512 %* 1024;") ~= nil).ToBe(true)
		Expect(Telemetry.MaxBodyBytes).ToBe(512 * 1024)
	end)
end)

return nil
