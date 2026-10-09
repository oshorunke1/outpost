--!strict
local Harness = require("@Tests/Harness")
local MockClient = require("@Tests/Backend/MockClient")
local TelemetryBuffer = require("@Logic/Backend/TelemetryBuffer")
local TelemetryCore = require("@Logic/Backend/TelemetryCore")
local Requests = require("@Logic/Backend/Requests")
local Telemetry = require("@Configs/Telemetry")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

local DayMillis = 24 * 60 * 60 * 1000

-- A core on a real BackendClient and MockTransport. Options can turn the server Offline, switch
-- the TelemetryEnabled flag off, move the clock or shrink the buffer.
local function NewRig(
	Options: { Live: boolean?, Enabled: boolean?, NowMillis: number?, Capacity: number?, SizeOf: any? }?
)
	local Given = Options or {}
	local Rig = MockClient.new()
	Rig.Warnings = {}
	Rig.Enabled = Given.Enabled ~= false
	Rig.Core = TelemetryCore.new({
		Schema = Telemetry,
		Buffer = TelemetryBuffer.new(Given.Capacity or 5000, Telemetry),
		Client = Rig.Client,
		Batch = Requests.TelemetryBatch,
		NowMillis = function()
			return Given.NowMillis or MockClient.NowMillis
		end,
		Now = function()
			return Rig.Clock.Now
		end,
		SizeOf = Given.SizeOf or function(_Event: any)
			return 100
		end,
		Enabled = function()
			return Rig.Enabled
		end,
		Live = Given.Live ~= false,
		Warn = function(Message: string)
			table.insert(Rig.Warnings, Message)
		end,
	})
	-- Every event that went out, across all batches.
	function Rig.Events(): { any }
		local All = {}
		for _, Request in Rig.Sent("/v1/telemetry/batch") do
			for _, Event in Request.Body.events do
				table.insert(All, Event)
			end
		end
		return All
	end
	function Rig.Warned(Text: string): boolean
		for _, Message in Rig.Warnings do
			if string.find(Message, Text, 1, true) ~= nil then
				return true
			end
		end
		return false
	end
	return Rig
end

Describe("TelemetryCore tracking", function()
	It("queues an event and sends it in one batch", function()
		local Rig = NewRig()
		Rig.Core:Track("orb_collected", 1001, 5)
		Rig.Core:Track("purchase_result", 1001, nil, { outcome = "Granted", itemId = "RedHat" })
		Expect(#Rig.Sends).ToBe(0)
		Expect(Rig.Core:Flush(10)).ToBe("Sent")
		Expect(#Rig.Sent("/v1/telemetry/batch")).ToBe(1)
		Expect(Rig.Events()).ToEqual({
			{ name = "orb_collected", ts = MockClient.NowMillis, userId = 1001, value = 5 },
			{
				name = "purchase_result",
				ts = MockClient.NowMillis,
				userId = 1001,
				dims = { outcome = "Granted", itemId = "RedHat" },
			},
		})
		Expect(Rig.Core:Flush(10)).ToBe("Empty")
		Expect(#Rig.Sent("/v1/telemetry/batch")).ToBe(1)
	end)

	It("an Offline server queues nothing and sends nothing", function()
		local Rig = NewRig({ Live = false })
		Rig.Core:Track("player_join", 1001)
		Expect(Rig.Core:Pending()).ToBe(0)
		Expect(Rig.Core:Flush(10)).ToBe("Empty")
		Expect(#Rig.Sends).ToBe(0)
	end)

	It("the TelemetryEnabled flag turned off stops tracking", function()
		local Rig = NewRig({ Enabled = false })
		Rig.Core:Track("player_join", 1001)
		Expect(Rig.Core:Pending()).ToBe(0)
		Rig.Enabled = true
		Rig.Core:Track("player_join", 1001)
		Expect(Rig.Core:Pending()).ToBe(1)
	end)

	It("an event the backend would refuse is thrown away and warned about, the rest still go", function()
		local Rig = NewRig()
		Rig.Core:Track("made_up_event", 1001)
		Rig.Core:Track("player_join", 1001.5)
		Rig.Core:Track("player_join", 1001)
		Expect(Rig.Core:Flush(10)).ToBe("Sent")
		Expect(#Rig.Events()).ToBe(1)
		Expect(Rig.Warned("threw away 2 telemetry events")).ToBe(true)
	end)

	It("a full buffer drops the oldest and warns with the count", function()
		local Rig = NewRig({ Capacity = 2 })
		Rig.Core:Track("player_join", 1)
		Rig.Core:Track("player_join", 2)
		Rig.Core:Track("player_join", 3)
		Rig.Core:Flush(10)
		Expect(Rig.Events()[1].userId).ToBe(2)
		Expect(Rig.Warned("dropped 1 telemetry events")).ToBe(true)
	end)

	It("a size that throws counts the event as refused instead of breaking the batch", function()
		local Rig = NewRig({
			SizeOf = function(Event: any)
				if Event.userId == 1 then
					error("no json")
				end
				return 100
			end,
		})
		Rig.Core:Track("player_join", 1)
		Rig.Core:Track("player_join", 2)
		Expect(Rig.Core:Flush(10)).ToBe("Sent")
		Expect(#Rig.Events()).ToBe(1)
		Expect(Rig.Events()[1].userId).ToBe(2)
	end)
end)

Describe("TelemetryCore sending", function()
	It("fails open, a batch the backend never took is dropped and warned, never resent", function()
		local Rig = NewRig()
		Rig.Core:Track("player_join", 1001)
		Rig.Controls.FailNext(503, "unavailable", nil, 100)
		Expect(Rig.Core:Flush(10)).ToBe("Lost")
		Expect(Rig.Warned("lost a telemetry batch of 1")).ToBe(true)
		Expect(Rig.Core:Pending()).ToBe(0)
		local Tries = #Rig.Sent("/v1/telemetry/batch")
		Expect(Rig.Core:Flush(10)).ToBe("Empty")
		Expect(#Rig.Sent("/v1/telemetry/batch")).ToBe(Tries)
	end)

	It("a client that throws loses the batch without breaking the caller", function()
		local Rig = NewRig()
		Rig.Core.Deps.Client = {
			Send = function()
				error("boom")
			end,
		}
		Rig.Core:Track("player_join", 1001)
		Expect(Rig.Core:Flush(10)).ToBe("Lost")
	end)

	It("logs the dropped count from the backend's 202", function()
		local Rig = NewRig({ NowMillis = MockClient.NowMillis - 2 * DayMillis })
		Rig.Core:Track("player_join", 1001)
		Rig.Core:Track("player_join", 1002)
		Expect(Rig.Core:Flush(10)).ToBe("Sent")
		Expect(Rig.Warned("the backend dropped 2 of 2")).ToBe(true)
	end)

	It("a 202 that dropped nothing warns about nothing", function()
		local Rig = NewRig()
		Rig.Core:Track("player_join", 1001)
		Rig.Core:Flush(10)
		Expect(#Rig.Warnings).ToBe(0)
	end)

	It("passes the deadline to the client", function()
		local Rig = NewRig()
		Rig.Core:Track("player_join", 1001)
		-- The backend asks for a 1 second wait, which would pass a half second deadline, so the
		-- client stops after one try instead of waiting.
		Rig.Controls.FailNext(503, "unavailable", 1, 100)
		local Started = Rig.Clock.Now
		Expect(Rig.Core:Flush(0.5)).ToBe("Lost")
		Expect(Rig.Clock.Now).ToBe(Started)
		Expect(#Rig.Sent("/v1/telemetry/batch")).ToBe(1)
	end)

	It("FlushAll sends every batch inside the time it is given", function()
		local Rig = NewRig()
		for UserId = 1, 1200 do
			Rig.Core:Track("player_join", UserId)
		end
		Rig.Core:FlushAll(20)
		Expect(#Rig.Sent("/v1/telemetry/batch")).ToBe(3)
		Expect(#Rig.Events()).ToBe(1200)
		Expect(Rig.Core:Pending()).ToBe(0)
	end)

	It("FlushAll stops when its time is up", function()
		local Rig = NewRig()
		for UserId = 1, 1200 do
			Rig.Core:Track("player_join", UserId)
		end
		Rig.Core:FlushAll(0)
		Expect(#Rig.Sent("/v1/telemetry/batch")).ToBe(0)
		Expect(Rig.Core:Pending()).ToBe(1200)
	end)
end)

Describe("TelemetryCore health events", function()
	It("a NetGuard drop carries only allow listed packet names and reasons", function()
		local Rig = NewRig()
		Rig.Core:NetGuardDrop(1001, "Shop.Buy", "Throttled")
		Rig.Core:NetGuardDrop(1001, "<script>hi", "BadPayload")
		Rig.Core:NetGuardDrop(1001, "Orb.Collect", "made up reason")
		Rig.Core:Flush(10)
		Expect(Rig.Events()).ToEqual({
			{
				name = "netguard_drop",
				ts = MockClient.NowMillis,
				userId = 1001,
				dims = { packet = "Shop.Buy", reason = "Throttled" },
			},
			{
				name = "netguard_drop",
				ts = MockClient.NowMillis,
				userId = 1001,
				dims = { packet = "Unknown", reason = "BadPayload" },
			},
			{ name = "netguard_drop", ts = MockClient.NowMillis, userId = 1001, dims = { packet = "Orb.Collect" } },
		})
	end)

	It("a breaker state is tracked only when it changes, and only a real state", function()
		local Rig = NewRig()
		Rig.Core:NoteBreaker("Closed")
		Rig.Core:NoteBreaker("Open")
		Rig.Core:NoteBreaker("Open")
		Rig.Core:NoteBreaker("Sideways")
		Rig.Core:NoteBreaker("HalfOpen")
		Rig.Core:NoteBreaker("Closed")
		Rig.Core:Flush(10)
		local States = {}
		for _, Event in Rig.Events() do
			Expect(Event.name).ToBe("breaker_state")
			Expect(Event.userId).ToBeNil()
			table.insert(States, Event.dims.state)
		end
		Expect(States).ToEqual({ "Open", "HalfOpen", "Closed" })
	end)
end)

return nil
