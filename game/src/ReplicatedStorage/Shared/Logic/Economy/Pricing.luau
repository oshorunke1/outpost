--!strict
-- Decides what a purchase costs and whether it goes through.
-- Notice Decide has no price argument at all. Prices only ever come from the catalog the server
-- passes in, so nothing a client sends can change what something costs.

export type Catalog = { [string]: { DisplayName: string, Price: number } }
export type Outcome = "Granted" | "AlreadyOwned" | "TooPoor" | "UnknownItem"
export type Decision = { Outcome: Outcome, Price: number, CoinsAfter: number }

local Pricing = {}

function Pricing.PriceOf(Catalog: Catalog, ItemId: string): number
	local Entry = Catalog[ItemId]
	if Entry == nil then
		error(`no price for item "{ItemId}"`, 2)
	end
	return Entry.Price
end

function Pricing.Decide(Catalog: Catalog, ItemId: string, Coins: number, Owned: { [string]: boolean }): Decision
	local Entry = Catalog[ItemId]
	if Entry == nil then
		return { Outcome = "UnknownItem", Price = 0, CoinsAfter = Coins }
	end
	local Price = Entry.Price
	if Owned[ItemId] then
		return { Outcome = "AlreadyOwned", Price = Price, CoinsAfter = Coins }
	end
	if Coins < Price then
		return { Outcome = "TooPoor", Price = Price, CoinsAfter = Coins }
	end
	return { Outcome = "Granted", Price = Price, CoinsAfter = Coins - Price }
end

-- Makes sure every id has exactly one entry with a whole, positive price. A spec runs this on the real shop.
function Pricing.CheckCatalog(Catalog: Catalog, Ids: { [string]: string }): (boolean, string?)
	for Id in Ids do
		local Entry = Catalog[Id]
		if Entry == nil then
			return false, `{Id} has no shop entry`
		end
		local Price = Entry.Price
		if type(Price) ~= "number" or Price ~= Price or Price < 1 or Price % 1 ~= 0 or Price == math.huge then
			return false, `{Id} has a bad price {tostring(Price)}`
		end
	end
	for Id in Catalog do
		if Ids[Id] == nil then
			return false, `{Id} is in the shop but is not an ItemId`
		end
	end
	return true, nil
end

return Pricing
