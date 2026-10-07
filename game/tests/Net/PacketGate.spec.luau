--!strict
local Harness = require("@Tests/Harness")
local PacketGate = require("@Logic/Net/PacketGate")
local RateLimiter = require("@Logic/Net/RateLimiter")
local Validate = require("@Logic/Net/Validate")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

local Colors = table.freeze({ Red = "Red", Blue = "Blue" })
local Enums = { Color = Colors }

-- A fresh gate with one inbound packet (Paint.Pick, 2 burst, 1 per second) and one outbound packet.
local function MakeGate(): PacketGate.PacketGate
	return PacketGate.new({
		["Paint.Pick"] = {
			Direction = "ClientToServer",
			Check = Validate.FromSpec(
				{ Kind = "Struct", Fields = { Color = { Kind = "Enum", Enum = "Color" } } },
				Enums
			),
			Limiter = RateLimiter.new(2, 1),
		},
		["Paint.Done"] = { Direction = "ServerToClient" },
	}, 5)
end

local function Noop() end

Describe("PacketGate.Listen and Seal", function()
	It("refuses unknown packets, outbound packets and duplicates", function()
		local Gate = MakeGate()
		Expect(function()
			Gate:Listen("Paint.Nope", Noop)
		end).ToThrow("Paint.Nope")
		Expect(function()
			Gate:Listen("Paint.Done", Noop)
		end).ToThrow("client to server")
		Gate:Listen("Paint.Pick", Noop)
		Expect(function()
			Gate:Listen("Paint.Pick", Noop)
		end).ToThrow("already")
	end)

	It("refuses new listeners after Seal, and refuses a second Seal", function()
		local Gate = MakeGate()
		Gate:Seal()
		Expect(Gate:IsSealed()).ToBe(true)
		Expect(function()
			Gate:Listen("Paint.Pick", Noop)
		end).ToThrow("sealed")
		Expect(function()
			Gate:Seal()
		end).ToThrow("sealed")
	end)

	It("refuses an inbound entry with no Check or Limiter", function()
		Expect(function()
			PacketGate.new({ ["A.B"] = { Direction = "ClientToServer" } }, 5)
		end).ToThrow("A.B")
	end)
end)

Describe("PacketGate.Admit", function()
	It("lets a good packet through and hands out its handler", function()
		local Gate = MakeGate()
		Gate:Listen("Paint.Pick", Noop)
		local Verdict = Gate:Admit(1, "Paint.Pick", 1, { Color = "Red" }, 0)
		Expect(Verdict).ToEqual({ Accepted = true, Reason = "Ok", ShouldLog = false })
		Expect(Gate:HandlerFor("Paint.Pick")).ToBe(Noop)
	end)

	It("drops unknown packets, outbound packets and packets nobody listens to", function()
		local Gate = MakeGate()
		Expect(Gate:Admit(1, "Paint.Nope", 1, nil, 0).Reason).ToBe("UnknownPacket")
		Expect(Gate:Admit(1, "Paint.Done", 1, nil, 0).Reason).ToBe("WrongDirection")
		Expect(Gate:Admit(1, "Paint.Pick", 1, { Color = "Red" }, 0).Reason).ToBe("NoHandler")
	end)

	It("drops calls with extra arguments", function()
		local Gate = MakeGate()
		Gate:Listen("Paint.Pick", Noop)
		Expect(Gate:Admit(1, "Paint.Pick", 2, { Color = "Red" }, 0).Reason).ToBe("TooManyArguments")
	end)

	It("drops payloads with extra keys, wrong values, or no table at all", function()
		local Gate = MakeGate()
		Gate:Listen("Paint.Pick", Noop)
		Expect(Gate:Admit(1, "Paint.Pick", 1, { Color = "Red", Price = 0 }, 0).Reason).ToBe("BadPayload")
		Expect(Gate:Admit(2, "Paint.Pick", 1, { Color = "Pink" }, 0).Reason).ToBe("BadPayload")
		Expect(Gate:Admit(3, "Paint.Pick", 1, "Red", 0).Reason).ToBe("BadPayload")
	end)

	It("throttles each player per packet and lets them back in after a refill", function()
		local Gate = MakeGate()
		Gate:Listen("Paint.Pick", Noop)
		local Good = { Color = "Blue" }
		Expect(Gate:Admit(1, "Paint.Pick", 1, Good, 0).Accepted).ToBe(true)
		Expect(Gate:Admit(1, "Paint.Pick", 1, Good, 0).Accepted).ToBe(true)
		Expect(Gate:Admit(1, "Paint.Pick", 1, Good, 0).Reason).ToBe("Throttled")
		Expect(Gate:Admit(2, "Paint.Pick", 1, Good, 0).Accepted).ToBe(true)
		Expect(Gate:Admit(1, "Paint.Pick", 1, Good, 1).Accepted).ToBe(true)
	end)

	It("spends tokens on bad payloads too, so junk spam still gets throttled", function()
		local Gate = MakeGate()
		Gate:Listen("Paint.Pick", Noop)
		Gate:Admit(1, "Paint.Pick", 1, "junk", 0)
		Gate:Admit(1, "Paint.Pick", 1, "junk", 0)
		Expect(Gate:Admit(1, "Paint.Pick", 1, { Color = "Red" }, 0).Reason).ToBe("Throttled")
	end)

	It("logs a drop at most once per player per packet every 5 seconds", function()
		local Gate = MakeGate()
		Gate:Listen("Paint.Pick", Noop)
		Expect(Gate:Admit(1, "Paint.Pick", 1, "junk", 0).ShouldLog).ToBe(true)
		Expect(Gate:Admit(1, "Paint.Pick", 1, "junk", 1).ShouldLog).ToBe(false)
		Expect(Gate:Admit(2, "Paint.Pick", 1, "junk", 1).ShouldLog).ToBe(true)
		Expect(Gate:Admit(1, "Paint.Pick", 1, "junk", 5).ShouldLog).ToBe(true)
	end)

	It("Forget resets one player's bucket and log timer and leaves others alone", function()
		local Gate = MakeGate()
		Gate:Listen("Paint.Pick", Noop)
		local Good = { Color = "Red" }
		Gate:Admit(1, "Paint.Pick", 1, Good, 0)
		Gate:Admit(1, "Paint.Pick", 1, Good, 0)
		Gate:Admit(2, "Paint.Pick", 1, Good, 0)
		Gate:Admit(2, "Paint.Pick", 1, Good, 0)
		Expect(Gate:Admit(1, "Paint.Pick", 1, "junk", 0).ShouldLog).ToBe(true)
		Gate:Forget(1)
		Expect(Gate:Admit(1, "Paint.Pick", 1, Good, 0).Accepted).ToBe(true)
		Expect(Gate:Admit(2, "Paint.Pick", 1, Good, 0).Reason).ToBe("Throttled")
	end)
end)

Describe("PacketGate.Admit with hostile input", function()
	It("refuses a packet name that is nil, NaN, a table or a number without throwing", function()
		local Gate = MakeGate()
		Gate:Listen("Paint.Pick", Noop)
		local Names: { any } = { false, 0 / 0, {}, 7, "" }
		for _, Name in Names do
			local Verdict = Gate:Admit(1, Name, 1, nil, 0)
			Expect(Verdict.Accepted).ToBe(false)
			Expect(Verdict.Reason).ToBe("UnknownPacket")
		end
		local NilVerdict = Gate:Admit(1, nil :: any, 1, nil, 0)
		Expect(NilVerdict.Accepted).ToBe(false)
		Expect(NilVerdict.Reason).ToBe("UnknownPacket")
	end)

	It("does not grow its log memory when a client sends endless unique unknown names", function()
		local Gate = MakeGate()
		for Index = 1, 200 do
			Gate:Admit(1, "Junk." .. Index, 1, nil, 0)
		end
		local Count = 0
		for _ in (Gate :: any).LastLogged[1] do
			Count += 1
		end
		Expect(Count <= 1).ToBe(true)
	end)

	It("refuses a bad argument count instead of throwing", function()
		local Gate = MakeGate()
		Gate:Listen("Paint.Pick", Noop)
		local Counts: { any } = { 0 / 0, "1", math.huge, {} }
		for Index, Count in Counts do
			local Verdict = Gate:Admit(Index, "Paint.Pick", Count, { Color = "Red" }, 0)
			Expect(Verdict.Accepted).ToBe(false)
		end
		Expect(Gate:Admit(9, "Paint.Pick", nil :: any, { Color = "Red" }, 0).Reason).ToBe("TooManyArguments")
		Expect(Gate:Admit(10, "Paint.Pick", 0, nil, 0).Reason).ToBe("BadPayload")
	end)

	It("never lets a client send an outbound packet, even with a good payload", function()
		local Gate = MakeGate()
		Gate:Listen("Paint.Pick", Noop)
		Expect(Gate:Admit(1, "Paint.Done", 1, { Color = "Red" }, 0).Reason).ToBe("WrongDirection")
	end)

	It("refuses NaN and function payloads as BadPayload", function()
		local Gate = MakeGate()
		Gate:Listen("Paint.Pick", Noop)
		Expect(Gate:Admit(1, "Paint.Pick", 1, 0 / 0, 0).Reason).ToBe("BadPayload")
		Expect(Gate:Admit(2, "Paint.Pick", 1, Noop, 0).Reason).ToBe("BadPayload")
		Expect(Gate:Admit(3, "Paint.Pick", 1, { Color = 0 / 0 }, 0).Reason).ToBe("BadPayload")
	end)

	It("fails closed when a Check function itself throws", function()
		local Gate = PacketGate.new({
			["A.B"] = {
				Direction = "ClientToServer",
				Check = function(): boolean
					error("boom")
				end,
				Limiter = RateLimiter.new(2, 1),
			},
		}, 5)
		Gate:Listen("A.B", Noop)
		local Verdict = Gate:Admit(1, "A.B", 1, {}, 0)
		Expect(Verdict.Accepted).ToBe(false)
		Expect(Verdict.Reason).ToBe("BadPayload")
	end)

	It("refuses a bad player key or clock instead of throwing", function()
		local Gate = MakeGate()
		Gate:Listen("Paint.Pick", Noop)
		Expect(Gate:Admit(0 / 0, "Paint.Pick", 1, { Color = "Red" }, 0).Accepted).ToBe(false)
		Expect(Gate:Admit(nil :: any, "Paint.Pick", 1, { Color = "Red" }, 0).Accepted).ToBe(false)
		Expect(Gate:Admit(1, "Paint.Pick", 1, { Color = "Red" }, 0 / 0).Accepted).ToBe(false)
	end)
end)

return nil
