--!strict
-- ShopService sells cosmetics for Coins. The client only names the item it wants.
-- On a ledger server the backend sets the price and takes the Coins. EconomyService checks the
-- player does not own the item, buys it and writes it into the save. It is acknowledged only once
-- a confirmed save holds it. Until then it stays unacknowledged, and the next join grants it.
-- A player still on the old save buys from the save exactly as in M1. The price comes from
-- Configs/Shop, and the check and the charge happen inside one Update with no waiting in between,
-- so two quick buys can never both pay out. A paused player can't buy until they reach a ledger server.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerStorage = game:GetService("ServerStorage")

local Pricing = require(ReplicatedStorage.Shared.Logic.Economy.Pricing)
local Shop = require(ReplicatedStorage.Shared.Configs.Shop)
local DataService = require(ServerStorage.Classes.Services.DataService)
local EconomyService = require(ServerStorage.Classes.Services.EconomyService)
local NetGuard = require(ServerStorage.Classes.Util.NetGuard)

local ShopService = {}

-- The M1 purchase, Coins and item in one Update.
local function BuyFromSave(Player: Player, ItemId: string): string
	local Decision: Pricing.Decision? = nil
	local Saved = DataService:Update(Player, function(Data)
		local Result = Pricing.Decide(Shop, ItemId, Data.Coins or 0, Data.OwnedItems)
		Decision = Result
		if Result.Outcome == "Granted" then
			Data.Coins = Result.CoinsAfter
			Data.OwnedItems[ItemId] = true
		end
	end)
	return if Saved and Decision ~= nil then Decision.Outcome else "Unavailable"
end

local function OnBuy(Player: Player, Payload: { ItemId: string })
	local ItemId = Payload.ItemId
	local Economy = DataService:EconomyFor(Player)
	local Outcome = "Unavailable"
	if Economy == "Legacy" then
		Outcome = BuyFromSave(Player, ItemId)
	elseif Economy == "Ledger" then
		Outcome = EconomyService:Purchase(Player, ItemId).Outcome
	end
	NetGuard.SendTo(Player, "Shop.Result", { ItemId = ItemId, Outcome = Outcome })
	DataService:PushSnapshot(Player)
end

function ShopService:Init()
	NetGuard.Listen("Shop.Buy", OnBuy)
end

return ShopService
