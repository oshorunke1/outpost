--!strict
local Harness = require("@Tests/Harness")
local PurchaseGuard = require("@Logic/Economy/PurchaseGuard")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

local function Counter(): () -> string
	local Count = 0
	return function()
		Count += 1
		return `buy-key-{Count}`
	end
end

Describe("PurchaseGuard lock", function()
	It("only one holder per player at a time", function()
		local Guard = PurchaseGuard.new(Counter())
		Expect(Guard:TryLock(1001)).ToBe(true)
		Expect(Guard:TryLock(1001)).ToBe(false)
		Expect(Guard:TryLock(1002)).ToBe(true)
		Guard:Unlock(1001)
		Expect(Guard:TryLock(1001)).ToBe(true)
	end)

	It("Forget drops the keys of a player who left", function()
		local Guard = PurchaseGuard.new(Counter())
		local Key = Guard:KeyFor(1001, "RedHat")
		Guard:Forget(1001)
		Expect(Guard:KeyFor(1001, "RedHat") ~= Key).ToBe(true)
	end)

	It("Forget keeps the lock and the keys while a purchase is still running", function()
		local Guard = PurchaseGuard.new(Counter())
		Guard:TryLock(1001)
		local Key = Guard:KeyFor(1001, "RedHat")
		Guard:Forget(1001)
		Expect(Guard:TryLock(1001)).ToBe(false)
		Expect(Guard:KeyFor(1001, "RedHat")).ToBe(Key)
	end)
end)

Describe("PurchaseGuard keys", function()
	It("one key per player and item, reused after RetryLater", function()
		local Guard = PurchaseGuard.new(Counter())
		local First = Guard:KeyFor(1001, "RedHat")
		Guard:Settle(1001, "RedHat", "RetryLater")
		Expect(Guard:KeyFor(1001, "RedHat")).ToBe(First)
		Expect(Guard:KeyFor(1001, "GoldCrown") ~= First).ToBe(true)
		Expect(Guard:KeyFor(1002, "RedHat") ~= First).ToBe(true)
	end)

	It("a Grant or a Refuse ends the key, so the next buy is a new purchase", function()
		for _, Action in { "Grant", "Refuse" } do
			local Guard = PurchaseGuard.new(Counter())
			local First = Guard:KeyFor(1001, "RedHat")
			Guard:Settle(1001, "RedHat", Action)
			Expect(Guard:KeyFor(1001, "RedHat") ~= First).ToBe(true)
		end
	end)

	It("refuses a key maker that hands out a key the backend would refuse", function()
		local Guard = PurchaseGuard.new(function()
			return "bad key"
		end)
		Expect(function()
			Guard:KeyFor(1001, "RedHat")
		end).ToThrow("key")
	end)
end)

return nil
