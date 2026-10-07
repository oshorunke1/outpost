--!strict
local Harness = require("@Tests/Harness")
local ItemId = require("@Shared/Enums/ItemId")
local Pricing = require("@Logic/Economy/Pricing")
local Shop = require("@Configs/Shop")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

local Catalog = {
	Hat = { DisplayName = "Hat", Price = 10 },
	Cape = { DisplayName = "Cape", Price = 40 },
}

Describe("Pricing.PriceOf", function()
	It("returns the catalog price for a known item", function()
		Expect(Pricing.PriceOf(Catalog, "Hat")).ToBe(10)
	end)

	It("errors on an unknown item", function()
		Expect(function()
			Pricing.PriceOf(Catalog, "Sword")
		end).ToThrow("Sword")
	end)
end)

Describe("Pricing.Decide", function()
	It("grants when the player has exactly the price", function()
		Expect(Pricing.Decide(Catalog, "Hat", 10, {})).ToEqual({ Outcome = "Granted", Price = 10, CoinsAfter = 0 })
	end)

	It("refuses when the player is one coin short", function()
		Expect(Pricing.Decide(Catalog, "Hat", 9, {})).ToEqual({ Outcome = "TooPoor", Price = 10, CoinsAfter = 9 })
	end)

	It("never charges for an item the player already owns", function()
		Expect(Pricing.Decide(Catalog, "Hat", 50, { Hat = true })).ToEqual({
			Outcome = "AlreadyOwned",
			Price = 10,
			CoinsAfter = 50,
		})
	end)

	It("a second buy right after the first is a no-op", function()
		local Owned: { [string]: boolean } = {}
		local First = Pricing.Decide(Catalog, "Cape", 100, Owned)
		Owned.Cape = true
		local Second = Pricing.Decide(Catalog, "Cape", First.CoinsAfter, Owned)
		Expect(First.Outcome).ToBe("Granted")
		Expect(Second.Outcome).ToBe("AlreadyOwned")
		Expect(Second.CoinsAfter).ToBe(60)
	end)

	It("refuses an unknown item without erroring", function()
		Expect(Pricing.Decide(Catalog, "Sword", 100, {})).ToEqual({
			Outcome = "UnknownItem",
			Price = 0,
			CoinsAfter = 100,
		})
	end)
end)

Describe("Pricing.CheckCatalog", function()
	It("the real shop has a sane price for every ItemId and nothing extra", function()
		local Ok, Problem = Pricing.CheckCatalog(Shop, ItemId)
		Expect(Problem).ToBeNil()
		Expect(Ok).ToBe(true)
	end)

	It("catches a missing entry, an extra entry and bad prices", function()
		local Ids = { Hat = "Hat", Cape = "Cape" }
		Expect((Pricing.CheckCatalog({ Hat = Catalog.Hat }, Ids))).ToBe(false)
		Expect((Pricing.CheckCatalog({ Hat = Catalog.Hat, Cape = Catalog.Cape, Boots = Catalog.Hat }, Ids))).ToBe(false)
		Expect((Pricing.CheckCatalog({ Hat = { DisplayName = "Hat", Price = 0 }, Cape = Catalog.Cape }, Ids))).ToBe(
			false
		)
		Expect((Pricing.CheckCatalog({ Hat = { DisplayName = "Hat", Price = 2.5 }, Cape = Catalog.Cape }, Ids))).ToBe(
			false
		)
		Expect((Pricing.CheckCatalog({ Hat = { DisplayName = "Hat", Price = -5 }, Cape = Catalog.Cape }, Ids))).ToBe(
			false
		)
	end)
end)

return nil
