--!strict
-- HudController shows the player's Coins and one Buy button for the Red Hat.
-- It never decides anything itself. It shows what the server sends and asks the server to buy.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local ItemId = require(ReplicatedStorage.Shared.Enums.ItemId)
local CoinsDisplay = require(ReplicatedStorage.Shared.Logic.Economy.CoinsDisplay)
local Shop = require(ReplicatedStorage.Shared.Configs.Shop)
local NetClient = require(ReplicatedStorage.Classes.Util.NetClient)

local FeaturedItem = ItemId.RedHat
local StatusText: { [string]: string } = {
	Granted = "Bought it!",
	AlreadyOwned = "You already own that",
	TooPoor = "Not enough Coins yet",
	UnknownItem = "That item does not exist",
	Unavailable = "The shop is busy, try again",
}

local HudController = {}

-- Gives a label or button the same simple look and puts it in place.
-- Text is typed as any because a union of the two GUI classes trips strict mode, and this is UI only.
local function Style(Text: any, Parent: Instance, Top: number)
	Text.Position = UDim2.fromOffset(16, Top)
	Text.Size = UDim2.fromOffset(240, 40)
	Text.BackgroundTransparency = 0.3
	Text.TextScaled = true
	Text.Text = ""
	Text.Parent = Parent
end

function HudController:Start()
	local Entry = Shop[FeaturedItem]
	local BuyText = `Buy {Entry.DisplayName} ({Entry.Price})`
	local PlayerGui = Players.LocalPlayer:WaitForChild("PlayerGui")

	local Gui = Instance.new("ScreenGui")
	Gui.Name = "OutpostHud"
	Gui.ResetOnSpawn = false
	local CoinsLabel = Instance.new("TextLabel")
	Style(CoinsLabel, Gui, 16)
	CoinsLabel.Text = "Coins 0"
	local BuyButton = Instance.new("TextButton")
	Style(BuyButton, Gui, 64)
	BuyButton.Text = BuyText
	local Status = Instance.new("TextLabel")
	Style(Status, Gui, 112)
	Gui.Parent = PlayerGui

	NetClient.On("Profile.Snapshot", function(Snapshot: any)
		CoinsLabel.Text = CoinsDisplay.Text(Snapshot.Coins, Snapshot.State)
		local Owns = table.find(Snapshot.OwnedItems, FeaturedItem) ~= nil
		BuyButton.Text = if Owns then `{Entry.DisplayName} owned` else BuyText
	end)
	NetClient.On("Shop.Result", function(Result: any)
		Status.Text = StatusText[Result.Outcome] or tostring(Result.Outcome)
	end)
	BuyButton.Activated:Connect(function()
		NetClient.Fire("Shop.Buy", { ItemId = FeaturedItem })
	end)

	NetClient.Fire("Profile.RequestSnapshot", nil)
end

return HudController
