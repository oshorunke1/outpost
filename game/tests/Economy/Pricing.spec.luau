--!strict
local Fs = require("@lune/fs")
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

	It("NaN coins give TooPoor, never Granted", function()
		local NanResult = Pricing.Decide(Catalog, "Hat", 0 / 0, {})
		Expect(NanResult.Outcome).ToBe("TooPoor")
		Expect(NanResult.CoinsAfter).ToBe(0)
	end)

	It("negative coins give TooPoor, never Granted", function()
		local NegResult = Pricing.Decide(Catalog, "Hat", -5, {})
		Expect(NegResult.Outcome).ToBe("TooPoor")
		Expect(NegResult.CoinsAfter).ToBe(0)
	end)

	It("infinite coins give TooPoor, never Granted", function()
		local InfResult = Pricing.Decide(Catalog, "Hat", math.huge, {})
		Expect(InfResult.Outcome).ToBe("TooPoor")
		Expect(InfResult.CoinsAfter).ToBe(0)
	end)

	It("string coins give TooPoor and don't error", function()
		local StringResult = Pricing.Decide(Catalog, "Hat", ("100" :: any) :: number, {})
		Expect(StringResult.Outcome).ToBe("TooPoor")
	end)

	It("nil Owned is treated as not owning anything", function()
		local NilOwned = Pricing.Decide(Catalog, "Hat", 20, (nil :: any) :: { [string]: boolean })
		Expect(NilOwned.Outcome).ToBe("Granted")
		Expect(NilOwned.CoinsAfter).ToBe(10)
	end)

	It("nil ItemId gives UnknownItem", function()
		local NilId = Pricing.Decide(Catalog, (nil :: any) :: string, 100, {})
		Expect(NilId.Outcome).ToBe("UnknownItem")
	end)

	It("number ItemId gives UnknownItem", function()
		local NumId = Pricing.Decide(Catalog, (123 :: any) :: string, 100, {})
		Expect(NumId.Outcome).ToBe("UnknownItem")
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

	It("rejects a NaN price", function()
		local Ids = { Hat = "Hat" }
		local BadCatalog = { Hat = { DisplayName = "Hat", Price = 0 / 0 } }
		Expect((Pricing.CheckCatalog(BadCatalog, Ids))).ToBe(false)
	end)

	It("rejects an infinite price", function()
		local Ids = { Hat = "Hat" }
		local BadCatalog = { Hat = { DisplayName = "Hat", Price = math.huge } }
		Expect((Pricing.CheckCatalog(BadCatalog, Ids))).ToBe(false)
	end)

	It("rejects an enum value that doesn't map to itself", function()
		local BadIds = { Hat = "Cap" }
		Expect((Pricing.CheckCatalog(Catalog, BadIds))).ToBe(false)
	end)
end)

Describe("Configs/Shop", function()
	-- The backend charges what its CATALOG says and the game shows what Configs/Shop says, and the
	-- Studio mock charges from Configs/Shop too. So the two lists must match, item by item.
	It("every item and price matches CATALOG in the backend's catalog.ts", function()
		local Source = Fs.readFile("../backend/src/modules/economy/catalog.ts")
		local Body = string.match(Source, "export const CATALOG = %{(.-)%} as const")
		assert(Body ~= nil, "CATALOG is missing from catalog.ts")
		local Backend: { [string]: number } = {}
		for Item, Price in string.gmatch(Body, "(%w+): %{ price: (%d+) %}") do
			assert(Backend[Item] == nil, `{Item} shows up twice`)
			Backend[Item] = tonumber(Price) :: number
		end
		for Item, Entry in Shop do
			Expect(Backend[Item]).ToBe(Entry.Price)
		end
		for Item, Price in Backend do
			Expect(Shop[Item] and Shop[Item].Price).ToBe(Price)
		end
		Expect(next(Backend) ~= nil).ToBe(true)
	end)
end)

return nil
