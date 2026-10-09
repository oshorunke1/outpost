--!strict
-- Earning, joining, shutdown. Purchases, the reconcile and the legacy credit are in EconomyCoreBuy.
local Harness = require("@Tests/Harness")
local EconomyCore = require("@Logic/Economy/EconomyCore")
local EconomyRig = require("@Tests/Economy/EconomyRig")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

local Tag = EconomyRig.BootTag

local function Reply(Status: number, Body: any?): any
	return { Ok = Status >= 200 and Status < 300, Status = Status, Body = Body, Headers = {} }
end

Describe("EconomyCore earning", function()
	It("a full batch goes out at once and the ledger pays it once", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001)
		Rig.Core:Earn(1001, 200)
		Expect(Rig.Keys("earn")).ToEqual({ `{Tag}:1001:1` })
		Expect(Rig.Wallet(1001)).ToBe(200)
		Expect(Rig.Core:Balance(1001)).ToBe(200)
	end)

	It("Coins under a full batch show at once and go out when the batch ages", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001)
		Rig.Core:Earn(1001, 5)
		Rig.Core:Earn(1001, 5)
		Expect(#Rig.Sent("earn")).ToBe(0)
		Expect(Rig.Core:Balance(1001)).ToBe(10)
		Rig.Clock.Now += 30
		Rig.Core:Tick()
		Expect(Rig.Wallet(1001)).ToBe(10)
		Expect(Rig.Core:Balance(1001)).ToBe(10)
	end)

	It("a refused add is not shown and is warned about on the next tick", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001)
		Rig.Core:Earn(1001, 2.5)
		Expect(Rig.Core:Balance(1001)).ToBe(0)
		Rig.Core:Tick()
		Expect(#Rig.Warnings).ToBe(1)
		Expect(string.find(Rig.Warnings[1], "refused 1 earns", 1, true) ~= nil).ToBe(true)
	end)

	It("a lost answer is retried with the same key and replays instead of paying twice", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001)
		Rig.Controls.LoseNextAnswer()
		Rig.Core:Earn(1001, 200)
		-- BackendClient retried the lost answer itself, and the second try was a replay.
		Expect(Rig.Keys("earn")).ToEqual({ `{Tag}:1001:1`, `{Tag}:1001:1` })
		Expect(Rig.Wallet(1001)).ToBe(200)
	end)

	It("a batch the backend can't take now waits with its key, then pays once", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001)
		Rig.Controls.FailNext(503, "ledger_unavailable", nil, 3)
		Rig.Core:Earn(1001, 200)
		Expect(Rig.Wallet(1001)).ToBe(0)
		Expect(Rig.Core:Balance(1001)).ToBe(200)
		Rig.Clock.Now += 10
		Rig.Core:Tick()
		Expect(Rig.Wallet(1001)).ToBe(200)
		local Keys = Rig.Keys("earn")
		Expect(#Keys).ToBe(4)
		for _, Key in Keys do
			Expect(Key).ToBe(`{Tag}:1001:1`)
		end
		Expect(Rig.Core:Balance(1001)).ToBe(200)
	end)

	It("a long outage keeps the batch for well over half an hour instead of dropping it", function()
		local Down = true
		local Rig = EconomyRig.new({
			Intercept = function(Request: any)
				if Down and type(Request.Body) == "table" and Request.Body.kind == "earn" then
					return Reply(503, { error = "ledger_unavailable" })
				end
				return nil
			end,
		})
		Rig.Player(1001)
		Rig.Core:Earn(1001, 200)
		for _ = 1, 29 do
			Rig.Clock.Now += 120
			Rig.Core:Tick()
		end
		-- Still waiting with its key. The open breaker means the Wallet can't be asked here.
		Expect(Rig.Batcher:RetryCount()).ToBe(1)
		Expect(Rig.Core:Balance(1001)).ToBe(200)
		Down = false
		Rig.Clock.Now += 120
		Rig.Core:Tick()
		Expect(Rig.Wallet(1001)).ToBe(200)
		Expect(#Rig.Warnings).ToBe(0)
		Expect(EconomyCore.EarnRetryPolicy.MaxAttempts >= 30).ToBe(true)
	end)

	It("an unencodable batch is final, counted and warned, and never sent again", function()
		local Rig = EconomyRig.new({
			Intercept = function(Request: any)
				if type(Request.Body) == "table" and Request.Body.kind == "earn" then
					return Reply(-4)
				end
				return nil
			end,
		})
		Rig.Player(1001)
		Rig.Core:Earn(1001, 200)
		Expect(#Rig.Sent("earn")).ToBe(1)
		Expect(Rig.Batcher:RetryCount()).ToBe(0)
		Expect(Rig.Core:Balance(1001)).ToBe(0)
		Rig.Clock.Now += 600
		Rig.Core:Tick()
		Expect(#Rig.Sent("earn")).ToBe(1)
		local Joined = table.concat(Rig.Warnings, "\n")
		Expect(string.find(Joined, "1 earn batches worth 200 Coins could never be sent", 1, true) ~= nil).ToBe(true)
	end)

	It("a definite refusal is counted, warned about on the tick, and never sent again", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001)
		Rig.Controls.FailNext(422, "nope")
		Rig.Core:Earn(1001, 200)
		Rig.Core:Tick()
		Expect(Rig.Core:Balance(1001)).ToBe(0)
		Expect(string.find(Rig.Warnings[1], "refused 1 earn batches worth 200", 1, true) ~= nil).ToBe(true)
	end)
end)

Describe("EconomyCore late join", function()
	It("the join's balance is what the player sees, Coins earned on other servers included", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001)
		Rig.Core:Earn(1001, 200)
		local Other = EconomyRig.new()
		Other.Core.Deps.Client = Rig.Client
		Other.Player(1001)
		Expect(Other.Core:Balance(1001)).ToBe(200)
		Expect(Other.Core:Balance(1002)).ToBe(0)
	end)

	It("earns are held while the join has not landed, and pay once with their key after it lands", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001, nil, false)
		Rig.Controls.FailNext(503, "unavailable", nil, 3)
		Expect(Rig.Core:Join(1001)).ToBe(false)
		Rig.Core:Earn(1001, 200)
		Rig.Core:Earn(1001, 200)
		Expect(#Rig.Sent("earn")).ToBe(0)
		Expect(Rig.Core:HeldCoins(1001)).ToBe(400)
		Expect(Rig.Core:Balance(1001)).ToBe(400)
		Expect(Rig.Core:Join(1001)).ToBe(true)
		Expect(Rig.Keys("earn")).ToEqual({ `{Tag}:1001:1`, `{Tag}:1001:2` })
		Expect(Rig.Wallet(1001)).ToBe(400)
		Expect(Rig.Core:HeldCoins(1001)).ToBe(0)
		Expect(Rig.Core:Balance(1001)).ToBe(400)
	end)

	It("a 404 on an earn holds the batch, asks for a rejoin and resends the same key, never refused", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001)
		Rig.AutoRejoin = true
		Rig.Controls.FailNext(404, "player_not_found")
		Rig.Core:Earn(1001, 200)
		Expect(Rig.Rejoins).ToEqual({ 1001 })
		Expect(Rig.Keys("earn")).ToEqual({ `{Tag}:1001:1`, `{Tag}:1001:1` })
		Expect(Rig.Wallet(1001)).ToBe(200)
		Rig.Core:Tick()
		Expect(#Rig.Warnings).ToBe(0)
		Expect(Rig.Batcher:TakeRefused()).ToBe(0)
	end)

	It("a 404 while the rejoin keeps failing holds the Coins instead of losing them", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001)
		Rig.Controls.FailNext(404, "player_not_found")
		Rig.Core:Earn(1001, 200)
		Expect(Rig.Core:IsJoined(1001)).ToBe(false)
		Expect(Rig.Core:HeldCoins(1001)).ToBe(200)
		Rig.Clock.Now += 600
		Rig.Core:Tick()
		Expect(#Rig.Sent("earn")).ToBe(1)
		Expect(Rig.Core:Join(1001)).ToBe(true)
		Expect(Rig.Wallet(1001)).ToBe(200)
	end)

	It("a player who leaves before the join lands keeps their held Coins until the join lands", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001, nil, false)
		Rig.Core:Earn(1001, 30)
		Rig.Core:Leave(1001)
		Expect(Rig.Core:HeldCoins(1001)).ToBe(30)
		Expect(Rig.Core:Join(1001)).ToBe(true)
		Expect(Rig.Wallet(1001)).ToBe(30)
	end)

	It("DropHeld gives up on held Coins with a warning and the total", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001, nil, false)
		Rig.Core:Earn(1001, 200)
		Expect(Rig.Core:DropHeld(1001)).ToBe(200)
		Expect(Rig.Core:HeldCoins(1001)).ToBe(0)
		Expect(Rig.Core:Outstanding()).ToBe(0)
		Expect(#Rig.Warnings).ToBe(1)
	end)
end)

Describe("EconomyCore leaving and shutdown", function()
	It("leaving sends the waiting batch whatever its size", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001)
		Rig.Core:Earn(1001, 15)
		Rig.Core:Leave(1001)
		Expect(Rig.Wallet(1001)).ToBe(15)
	end)

	It("a same-server rejoin joins again, so the balance shown is the wallet", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001)
		Rig.Core:Earn(1001, 200)
		Rig.Core:Leave(1001)
		Rig.Core:BeginVisit(1001)
		Expect(Rig.Core:IsJoined(1001)).ToBe(false)
		Expect(Rig.Core:AfterJoin(1001)).ToBe(false)
		Expect(Rig.Core:Join(1001)).ToBe(true)
		Expect(Rig.Core:AfterJoin(1001)).ToBe(true)
		Expect(Rig.Core:Balance(1001)).ToBe(200)
		Expect(Rig.Wallet(1001)).ToBe(200)
		Expect(#Rig.Sent("join")).ToBe(2)
	end)

	It("a batch still retrying after the player left keeps going until it pays", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001)
		Rig.Controls.FailNext(503, "ledger_unavailable", nil, 3)
		Rig.Core:Earn(1001, 200)
		Rig.Core:Leave(1001)
		Rig.Clock.Now += 60
		Rig.Core:Tick()
		Expect(Rig.Wallet(1001)).ToBe(200)
	end)

	It("shutdown takes every batch, waiting, retrying and held, and Deliver joins first", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001)
		Rig.Player(1002, nil, false)
		Rig.Player(1003)
		Rig.Core:Earn(1001, 15)
		Rig.Core:Earn(1002, 200)
		Rig.Controls.FailNext(503, "ledger_unavailable", nil, 3)
		Rig.Core:Earn(1003, 200)
		Expect(Rig.Batcher:RetryCount()).ToBe(1)
		local All = Rig.Core:TakeEverything()
		Expect(#All).ToBe(3)
		Expect(Rig.Core:Outstanding()).ToBe(415)
		for _, Flush in All do
			Rig.Core:Deliver(Flush, 20)
		end
		Expect(Rig.Wallet(1001)).ToBe(15)
		Expect(Rig.Wallet(1002)).ToBe(200)
		Expect(Rig.Wallet(1003)).ToBe(200)
		Expect(Rig.Core:Outstanding()).ToBe(0)
	end)

	It("Deliver passes its seconds on as the deadline", function()
		local Seen: { number } = {}
		local Rig = EconomyRig.new()
		Rig.Player(1001)
		local Client = Rig.Client
		local Send = Client.Send
		Client.Send = function(Self: any, Request: any, Options: any)
			table.insert(Seen, if Options then Options.DeadlineSeconds else -1)
			return Send(Self, Request, Options)
		end
		Rig.Core:Earn(1001, 15)
		for _, Flush in Rig.Core:TakeEverything() do
			Rig.Core:Deliver(Flush, 20)
		end
		Expect(Seen).ToEqual({ 20 })
	end)
end)

return nil
