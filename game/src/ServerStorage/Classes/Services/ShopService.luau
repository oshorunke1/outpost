--!strict
-- ShopService sells cosmetics for Coins. The client only names the item it wants.
-- The price comes from Configs/Shop on the server, and the check and the charge happen inside one
-- DataService Update with no waiting in between, so two quick buys can never both pay out.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerStorage = game:GetService("ServerStorage")

local Pricing = require(ReplicatedStorage.Shared.Logic.Economy.Pricing)
local Shop = require(ReplicatedStorage.Shared.Configs.Shop)
local DataService = require(ServerStorage.Classes.Services.DataService)
local NetGuard = require(ServerStorage.Classes.Util.NetGuard)

local ShopService = {}

local function OnBuy(Player: Player, Payload: { ItemId: string })
	local ItemId = Payload.ItemId
	local Decision: Pricing.Decision? = nil
	local Saved = DataService:Update(Player, function(Data)
		local Result = Pricing.Decide(Shop, ItemId, Data.Coins, Data.OwnedItems)
		Decision = Result
		if Result.Outcome == "Granted" then
			Data.Coins = Result.CoinsAfter
			Data.OwnedItems[ItemId] = true
		end
	end)

	local Outcome = "Unavailable"
	if Saved and Decision ~= nil then
		Outcome = Decision.Outcome
	end
	NetGuard.SendTo(Player, "Shop.Result", { ItemId = ItemId, Outcome = Outcome })
	if Saved then
		DataService:PushSnapshot(Player)
	end
end

function ShopService:Init()
	NetGuard.Listen("Shop.Buy", OnBuy)
end

return ShopService
