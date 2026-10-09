--!strict
-- A purchase is acknowledged only once a confirmed save holds the item. Until then the backend
-- keeps it on the unfulfilled list, so a crash, a DataStore outage or a stolen session ends with
-- the next server granting it. Each case ends with the item granted once and the Coins charged once.
local Harness = require("@Tests/Harness")
local EconomyRig = require("@Tests/Economy/EconomyRig")
local Requests = require("@Logic/Backend/Requests")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

local function Seed(Rig: any, UserId: number, Coins: number)
	assert(Rig.Client:Send(Requests.Earn(UserId, Coins, `seed:{UserId}:{Coins}`)).Status == 201, "seed failed")
end

local function Unfulfilled(Rig: any, UserId: number): number
	return #Rig.Client:Send(Requests.Unfulfilled(UserId)).Body.purchases
end

local function Purchases(Rig: any): number
	local Count = 0
	for _, Request in Rig.Sent("purchase") do
		if string.sub(Request.Headers["Idempotency-Key"], 1, 4) == "buy-" then
			Count += 1
		end
	end
	return Count
end

Describe("EconomyCore durable acknowledgement", function()
	It("a purchase is acknowledged only after a confirmed save that holds the item", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001)
		Seed(Rig, 1001, 30)
		Expect(Rig.Core:Purchase(1001, "RedHat").Outcome).ToBe("Granted")
		local SavedAt = Rig.FirstAt("save") :: number
		local AckedAt = Rig.FirstAt("fulfilled") :: number
		Expect(SavedAt ~= nil and AckedAt ~= nil and SavedAt < AckedAt).ToBe(true)
		Expect(Rig.Durable[1001].OwnedItems.RedHat).ToBe(true)
		Expect(Unfulfilled(Rig, 1001)).ToBe(0)
	end)

	It("a crash before the save lands sends no ack, and the next server grants the hat once", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001)
		Seed(Rig, 1001, 60)
		Rig.FailSaveNow = true
		Expect(Rig.Core:Purchase(1001, "RedHat").Outcome).ToBe("Granted")
		Expect(#Rig.Sent("fulfilled")).ToBe(0)
		Expect(Rig.Durable[1001].OwnedItems.RedHat).ToBeNil()
		local Next = Rig.Crash(1001)
		Expect(Next.Saves[1001].OwnedItems.RedHat).ToBe(true)
		Expect(Next.Durable[1001].OwnedItems.RedHat).ToBe(true)
		Expect(Unfulfilled(Next, 1001)).ToBe(0)
		Expect(Next.Wallet(1001)).ToBe(35)
		Expect(Next.Core:Purchase(1001, "RedHat").Outcome).ToBe("AlreadyOwned")
		Expect(Next.Wallet(1001)).ToBe(35)
		Expect(Purchases(Rig) + Purchases(Next)).ToBe(1)
	end)

	It("a DataStore outage at shutdown leaves the purchase unacknowledged for the next server", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001)
		Seed(Rig, 1001, 30)
		Rig.FailSaveNow = true
		Rig.Core:Purchase(1001, "RedHat")
		Rig.Core:Leave(1001)
		for _, Flush in Rig.Core:TakeEverything() do
			Rig.Core:Deliver(Flush, 20)
		end
		Expect(#Rig.Sent("fulfilled")).ToBe(0)
		Expect(Unfulfilled(Rig, 1001)).ToBe(1)
		local Next = Rig.Crash(1001)
		Expect(Next.Saves[1001].OwnedItems.RedHat).ToBe(true)
		Expect(Unfulfilled(Next, 1001)).ToBe(0)
		Expect(Next.Wallet(1001)).ToBe(5)
	end)

	It("a stolen session never acknowledges, and the server that took the save grants the hat once", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001)
		Seed(Rig, 1001, 30)
		-- Another server takes the save while this purchase runs, so this server's saves never land.
		local Grant = Rig.Core.Deps.Save.Grant
		Rig.Core.Deps.Save.Grant = function(UserId: number, Items: { string })
			local Granted = Grant(UserId, Items)
			Rig.Saves[UserId] = nil
			return Granted
		end
		Rig.Core:Purchase(1001, "RedHat")
		Expect(#Rig.Sent("fulfilled")).ToBe(0)
		local Next = Rig.Crash(1001)
		Expect(Next.Saves[1001].OwnedItems.RedHat).ToBe(true)
		Expect(Unfulfilled(Next, 1001)).ToBe(0)
		Expect(Next.Wallet(1001)).ToBe(5)
		Expect(Purchases(Rig) + Purchases(Next)).ToBe(1)
	end)

	It("the join reconcile also acknowledges only after a confirmed save", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001)
		Seed(Rig, 1001, 30)
		Rig.Client:Send(Requests.Purchase(1001, "RedHat", "stranded:1001:RedHat"))
		Rig.FailSaveNow = true
		Expect(Rig.Core:Reconcile(1001)).ToBe(true)
		Expect(Rig.Saves[1001].OwnedItems.RedHat).ToBe(true)
		Expect(#Rig.Sent("fulfilled")).ToBe(0)
		Expect(Unfulfilled(Rig, 1001)).ToBe(1)
		Rig.FailSaveNow = false
		Expect(Rig.Core:Reconcile(1001)).ToBe(true)
		Expect((Rig.FirstAt("save") :: number) < (Rig.FirstAt("fulfilled") :: number)).ToBe(true)
		Expect(Unfulfilled(Rig, 1001)).ToBe(0)
		Expect(Rig.Wallet(1001)).ToBe(5)
	end)
end)

return nil
