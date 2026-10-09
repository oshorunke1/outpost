--!strict
-- Purchases, the join reconcile and the legacy credit. Earning is in EconomyCore.spec.
local Harness = require("@Tests/Harness")
local EconomyRig = require("@Tests/Economy/EconomyRig")
local Requests = require("@Logic/Backend/Requests")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

local Tag = EconomyRig.BootTag

-- Puts Coins straight into the player's ledger, as if they were earned on another server.
local function Seed(Rig: any, UserId: number, Coins: number)
	local Response = Rig.Client:Send(Requests.Earn(UserId, Coins, `seed:{UserId}:{Coins}`))
	assert(Response.Status == 201, "seed earn failed")
end

-- Makes a purchase on another server that charged but never got acknowledged.
local function StrandedPurchase(Rig: any, UserId: number, ItemId: string): string
	local Response = Rig.Client:Send(Requests.Purchase(UserId, ItemId, `stranded:{UserId}:{ItemId}`))
	assert(Response.Status == 201, "stranded purchase failed")
	return Response.Body.transactionId
end

local function Unfulfilled(Rig: any, UserId: number): number
	return #Rig.Client:Send(Requests.Unfulfilled(UserId)).Body.purchases
end

Describe("EconomyCore purchases", function()
	It("a purchase charges the ledger, writes the item, then acknowledges it", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001)
		Seed(Rig, 1001, 30)
		local Decision = Rig.Core:Purchase(1001, "RedHat")
		Expect(Decision.Action).ToBe("Grant")
		Expect(Decision.Outcome).ToBe("Granted")
		Expect(Rig.Saves[1001].OwnedItems.RedHat).ToBe(true)
		Expect(Rig.Wallet(1001)).ToBe(5)
		Expect(Rig.Core:Balance(1001)).ToBe(5)
		Expect(#Rig.Sent("fulfilled")).ToBe(1)
		Expect(Unfulfilled(Rig, 1001)).ToBe(0)
	end)

	It("an item already in the save is refused with nothing sent", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001, { OwnedItems = { RedHat = true } })
		Seed(Rig, 1001, 30)
		local Decision = Rig.Core:Purchase(1001, "RedHat")
		Expect(Decision.Outcome).ToBe("AlreadyOwned")
		Expect(#Rig.Sent("purchase")).ToBe(0)
		Expect(Rig.Wallet(1001)).ToBe(30)
	end)

	It("the unsent Coins go out first, so the backend sees what the player sees", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001)
		Rig.Core:Earn(1001, 30)
		Expect(#Rig.Sent("earn")).ToBe(0)
		local Decision = Rig.Core:Purchase(1001, "RedHat")
		Expect(Decision.Action).ToBe("Grant")
		Expect(Rig.Keys("earn")).ToEqual({ `{Tag}:1001:1` })
		Expect(Rig.Wallet(1001)).ToBe(5)
	end)

	It("a lost answer is RetryLater, and the next click replays the same charge instead of a second one", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001)
		Seed(Rig, 1001, 60)
		-- The backend charges, then every answer is lost, so the click ends in RetryLater.
		Rig.Controls.LoseNextAnswer()
		Rig.Controls.FailNext(503, "unavailable", nil, 2)
		local First = Rig.Core:Purchase(1001, "RedHat")
		Expect(First.Action).ToBe("RetryLater")
		Expect(Rig.Saves[1001].OwnedItems.RedHat).ToBeNil()
		Expect(Rig.Wallet(1001)).ToBe(35)
		local Second = Rig.Core:Purchase(1001, "RedHat")
		Expect(Second.Action).ToBe("Grant")
		Expect(Rig.Saves[1001].OwnedItems.RedHat).ToBe(true)
		Expect(Rig.Wallet(1001)).ToBe(35)
		local Keys = Rig.Keys("purchase")
		for _, Key in Keys do
			Expect(Key).ToBe("buy-key-1")
		end
		Expect(Rig.KeyCount).ToBe(1)
	end)

	It("a definite refusal ends the key, so the next click is a new purchase", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001)
		local Poor = Rig.Core:Purchase(1001, "RedHat")
		Expect(Poor.Action).ToBe("Refuse")
		Expect(Poor.Outcome).ToBe("TooPoor")
		Seed(Rig, 1001, 25)
		Expect(Rig.Core:Purchase(1001, "RedHat").Action).ToBe("Grant")
		Expect(Rig.Keys("purchase")).ToEqual({ "buy-key-1", "buy-key-2" })
	end)

	It("a player whose join has not landed gets RetryLater with nothing sent", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001, nil, false)
		Expect(Rig.Core:Purchase(1001, "RedHat").Action).ToBe("RetryLater")
		Expect(#Rig.Sent("purchase")).ToBe(0)
	end)

	It("a click while the player's lock is held gets RetryLater with nothing sent", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001)
		Seed(Rig, 1001, 30)
		Rig.Guard:TryLock(1001)
		Expect(Rig.Core:Purchase(1001, "RedHat").Action).ToBe("RetryLater")
		Expect(#Rig.Sent("purchase")).ToBe(0)
		Rig.Guard:Unlock(1001)
		Expect(Rig.Core:Purchase(1001, "RedHat").Action).ToBe("Grant")
	end)

	It("a click during the join reconcile can't buy what the reconcile is granting", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001)
		Seed(Rig, 1001, 60)
		StrandedPurchase(Rig, 1001, "RedHat")
		local Inner: any = nil
		local Owned = Rig.Core.Deps.Save.Owned
		Rig.Core.Deps.Save.Owned = function(UserId: number)
			-- The player clicks Buy while the reconcile is between its two steps.
			if Inner == nil then
				Inner = Rig.Core:Purchase(1001, "RedHat")
			end
			return Owned(UserId)
		end
		Expect(Rig.Core:Reconcile(1001)).ToBe(true)
		Expect(Inner.Action).ToBe("RetryLater")
		Expect(Rig.Saves[1001].OwnedItems.RedHat).ToBe(true)
		Expect(Rig.Wallet(1001)).ToBe(35)
		Expect(Rig.Core:Purchase(1001, "RedHat").Outcome).ToBe("AlreadyOwned")
		Expect(Rig.Wallet(1001)).ToBe(35)
	end)

	It(
		"a Grant the save refuses stays unacknowledged, and the next reconcile grants it without charging again",
		function()
			local Rig = EconomyRig.new()
			Rig.Player(1001)
			Seed(Rig, 1001, 30)
			Rig.FailGrant = true
			local Decision = Rig.Core:Purchase(1001, "RedHat")
			Expect(Decision.Outcome).ToBe("Unavailable")
			Expect(#Rig.Sent("fulfilled")).ToBe(0)
			Expect(Unfulfilled(Rig, 1001)).ToBe(1)
			Rig.FailGrant = false
			Expect(Rig.Core:Reconcile(1001)).ToBe(true)
			Expect(Rig.Saves[1001].OwnedItems.RedHat).ToBe(true)
			Expect(Unfulfilled(Rig, 1001)).ToBe(0)
			Expect(Rig.Wallet(1001)).ToBe(5)
		end
	)

	It("the pre-purchase flush and the purchase share one 10 second deadline", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001)
		Seed(Rig, 1001, 30)
		Rig.Core:Earn(1001, 5)
		-- The flush is told to wait 10 seconds, which uses up the whole click.
		Rig.Controls.FailNext(503, "ledger_unavailable", 10, 1)
		local Decision = Rig.Core:Purchase(1001, "RedHat")
		Expect(Decision.Action).ToBe("RetryLater")
		Expect(#Rig.Sent("purchase")).ToBe(0)
		Expect(Rig.Clock.Now).ToBe(10)
		Expect(Rig.Wallet(1001)).ToBe(35)
		-- The key was never used, so the next click sends it for the first time.
		Expect(Rig.Core:Purchase(1001, "RedHat").Action).ToBe("Grant")
		Expect(Rig.Keys("purchase")).ToEqual({ "buy-key-1" })
	end)

	It("the purchase only gets the time the flush left over", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001)
		Seed(Rig, 1001, 30)
		Rig.Core:Earn(1001, 5)
		local Deadlines: { number } = {}
		local Send = Rig.Client.Send
		Rig.Client.Send = function(Self: any, Request: any, Options: any)
			if type(Request.Body) == "table" and Request.Body.kind == "purchase" then
				table.insert(Deadlines, Options.DeadlineSeconds)
			end
			return Send(Self, Request, Options)
		end
		Rig.Controls.FailNext(503, "ledger_unavailable", 7, 1)
		Expect(Rig.Core:Purchase(1001, "RedHat").Action).ToBe("Grant")
		Expect(Deadlines).ToEqual({ 3 })
	end)

	It("a throwing acknowledge is just a failed one", function()
		local Rig = EconomyRig.new()
		Expect(Rig.Core:Acknowledge("not-a-uuid")).ToBe(false)
		Expect(#Rig.Warnings).ToBe(1)
		Expect(#Rig.Sends).ToBe(0)
	end)
end)

Describe("EconomyCore reconcile", function()
	It("grants every unacknowledged item the save lacks and acknowledges each purchase", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001, { OwnedItems = { GoldCrown = true } })
		Seed(Rig, 1001, 200)
		StrandedPurchase(Rig, 1001, "RedHat")
		StrandedPurchase(Rig, 1001, "GoldCrown")
		Expect(Rig.Core:Reconcile(1001)).ToBe(true)
		Expect(Rig.Saves[1001].OwnedItems).ToEqual({ RedHat = true, GoldCrown = true })
		Expect(#Rig.Sent("fulfilled")).ToBe(2)
		Expect(Unfulfilled(Rig, 1001)).ToBe(0)
	end)

	It("a save that refuses the grant acknowledges nothing, so the next join tries again", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001)
		Seed(Rig, 1001, 30)
		StrandedPurchase(Rig, 1001, "RedHat")
		Rig.FailGrant = true
		Expect(Rig.Core:Reconcile(1001)).ToBe(false)
		Expect(#Rig.Sent("fulfilled")).ToBe(0)
		Expect(Unfulfilled(Rig, 1001)).ToBe(1)
	end)

	It("no answer means try again later, with nothing granted", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001)
		Rig.Controls.FailNext(503, "unavailable", nil, 3)
		Expect(Rig.Core:Reconcile(1001)).ToBe(false)
		Expect(Rig.Saves[1001].OwnedItems).ToEqual({})
	end)
end)

Describe("EconomyCore legacy credit", function()
	It("credits the LegacyCoins once in chunks with fixed keys, then marks the save", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001, { OwnedItems = {}, LegacyCoins = 1234 })
		Expect(Rig.Core:CreditLegacy(1001)).ToBe("Done")
		Expect(Rig.Keys("legacy")).ToEqual({ "legacy-1001-1", "legacy-1001-2" })
		local Amounts = {}
		for _, Request in Rig.Sent("legacy") do
			table.insert(Amounts, Request.Body.amount)
		end
		Expect(Amounts).ToEqual({ 1000, 234 })
		Expect(Rig.Wallet(1001)).ToBe(1234)
		Expect(Rig.Core:Balance(1001)).ToBe(1234)
		Expect(Rig.Saves[1001].LegacyCredited).ToBe(true)
		Expect(Rig.Saves[1001].LegacyCoins).ToBe(1234)
		Expect(Rig.Core:CreditLegacy(1001)).ToBe("Nothing")
		Expect(#Rig.Sent("legacy")).ToBe(2)
	end)

	It("the save holding LegacyCoins is stored before any chunk goes out", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001, { OwnedItems = {}, LegacyCoins = 40 })
		Rig.FailSaveNow = true
		Expect(Rig.Core:CreditLegacy(1001)).ToBe("RetryLater")
		Expect(#Rig.Sent("legacy")).ToBe(0)
		Expect(Rig.Saves[1001].LegacyCredited).ToBeNil()
		Rig.FailSaveNow = false
		Expect(Rig.Core:CreditLegacy(1001)).ToBe("Done")
		Expect(Rig.Wallet(1001)).ToBe(40)
	end)

	It("a crash between the credit and the mark replays the same keys and pays nothing more", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001, { OwnedItems = {}, LegacyCoins = 1500 })
		Rig.FailMark = true
		Expect(Rig.Core:CreditLegacy(1001)).ToBe("RetryLater")
		Expect(Rig.Wallet(1001)).ToBe(1500)
		Expect(Rig.Saves[1001].LegacyCredited).ToBeNil()
		Rig.FailMark = false
		Expect(Rig.Core:CreditLegacy(1001)).ToBe("Done")
		Expect(Rig.Keys("legacy")).ToEqual({ "legacy-1001-1", "legacy-1001-2", "legacy-1001-1", "legacy-1001-2" })
		Expect(Rig.Wallet(1001)).ToBe(1500)
		Expect(Rig.Core:Balance(1001)).ToBe(1500)
	end)

	It("a rerun on a fresh server after a crash replays too, because the keys never change", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001, { OwnedItems = {}, LegacyCoins = 1500 })
		Rig.FailMark = true
		Rig.Core:CreditLegacy(1001)
		-- A new EconomyCore on another server, same ledger.
		local Fresh = EconomyRig.new()
		Fresh.Client = Rig.Client
		Fresh.Core.Deps.Client = Rig.Client
		Fresh.Player(1001, { OwnedItems = {}, LegacyCoins = 1500 })
		Expect(Fresh.Core:CreditLegacy(1001)).ToBe("Done")
		Expect(Rig.Wallet(1001)).ToBe(1500)
	end)

	It("a chunk that fails part way stops, and the rerun replays what landed and sends the rest", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001, { OwnedItems = {}, LegacyCoins = 2500 })
		local Count = 0
		local Send = Rig.Client.Send
		Rig.Client.Send = function(Self: any, Request: any, Options: any)
			if type(Request.Body) == "table" and Request.Body.reason == "legacy_migration" then
				Count += 1
				if Count == 2 then
					Rig.Controls.FailNext(503, "ledger_unavailable", nil, 3)
				end
			end
			return Send(Self, Request, Options)
		end
		Expect(Rig.Core:CreditLegacy(1001)).ToBe("RetryLater")
		Expect(Rig.Wallet(1001)).ToBe(1000)
		Expect(Rig.Saves[1001].LegacyCredited).ToBeNil()
		Rig.Clock.Now += 60
		Expect(Rig.Core:CreditLegacy(1001)).ToBe("Done")
		Expect(Rig.Wallet(1001)).ToBe(2500)
	end)

	It("waits for the join, and a 404 asks for a rejoin and tries again later", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001, { OwnedItems = {}, LegacyCoins = 40 }, false)
		Expect(Rig.Core:CreditLegacy(1001)).ToBe("RetryLater")
		Expect(#Rig.Sent("legacy")).ToBe(0)
		Expect(Rig.Core:Join(1001)).ToBe(true)
		Rig.Controls.FailNext(404, "player_not_found")
		Expect(Rig.Core:CreditLegacy(1001)).ToBe("RetryLater")
		Expect(Rig.Rejoins).ToEqual({ 1001 })
		Expect(Rig.Core:IsJoined(1001)).ToBe(false)
		Expect(Rig.Core:Join(1001)).ToBe(true)
		Expect(Rig.Core:CreditLegacy(1001)).ToBe("Done")
		Expect(Rig.Wallet(1001)).ToBe(40)
	end)

	It("a definite refusal never marks the save and is warned about for an operator", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001, { OwnedItems = {}, LegacyCoins = 40 })
		Rig.Controls.FailNext(409, "idempotency_key_reuse")
		Expect(Rig.Core:CreditLegacy(1001)).ToBe("Refused")
		Expect(Rig.Saves[1001].LegacyCredited).ToBeNil()
		Expect(#Rig.Warnings).ToBe(1)
	end)

	It("a balance over the cap is left in the save for an operator with nothing sent", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001, { OwnedItems = {}, LegacyCoins = 1000001 })
		Expect(Rig.Core:CreditLegacy(1001)).ToBe("Refused")
		Expect(#Rig.Sent("legacy")).ToBe(0)
		Expect(Rig.Saves[1001].LegacyCredited).ToBeNil()
	end)

	It("runs under the player's lock, so a purchase can't run alongside it", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001, { OwnedItems = {}, LegacyCoins = 40 })
		Rig.Guard:TryLock(1001)
		Expect(Rig.Core:CreditLegacy(1001)).ToBe("RetryLater")
		Expect(#Rig.Sent("legacy")).ToBe(0)
	end)
end)

Describe("EconomyCore after the join", function()
	It("reconciles, then credits the legacy Coins, and is settled once both are done", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001, { OwnedItems = {}, LegacyCoins = 40 })
		Rig.Controls.FailNext(503, "unavailable", nil, 3)
		Expect(Rig.Core:AfterJoin(1001)).ToBe(false)
		Expect(#Rig.Sent("legacy")).ToBe(0)
		Expect(Rig.Core:AfterJoin(1001)).ToBe(true)
		Expect(Rig.Wallet(1001)).ToBe(40)
		Expect(Rig.Core:AfterJoin(1001)).ToBe(true)
		-- Three tries in the failed reconcile, one that worked, and none once it was settled.
		Expect(#Rig.Sent("unfulfilled")).ToBe(4)
		Expect(#Rig.Sent("legacy")).ToBe(1)
	end)

	It("is never settled before the join lands", function()
		local Rig = EconomyRig.new()
		Rig.Player(1001, nil, false)
		Expect(Rig.Core:AfterJoin(1001)).ToBe(false)
		Expect(#Rig.Sends).ToBe(0)
	end)
end)

return nil
