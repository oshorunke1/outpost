--!strict
local Harness = require("@Tests/Harness")
local JsonEncode = require("@Scripts/JsonEncode")
local ManifestBuilder = require("@Scripts/ManifestBuilder")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

local ShopSource = table.concat({
	"--!strict",
	"local ShopService = {}",
	"function ShopService:Init()",
	'\tNetGuard.Listen("Shop.Buy", OnBuy)',
	'\tNetGuard.Listen( "Shop.Buy", OnBuy)',
	"end",
	"return ShopService",
}, "\n") .. "\n"

local HudSource = "--!strict\nlocal HudController = {}\nfunction HudController:Start()\nend\nreturn HudController\n"

local Packets = {
	{ Name = "Shop.Result", Direction = "ServerToClient", Payload = { Kind = "None" } },
	{
		Name = "Shop.Buy",
		Direction = "ClientToServer",
		Payload = { Kind = "Struct", Fields = { ItemId = { Kind = "Enum", Enum = "ItemId" } } },
		RateLimit = { Capacity = 3, RefillPerSecond = 1 },
	},
}

local function Files(Order: string, LineEnding: string): { ManifestBuilder.SourceFile }
	local Shop = {
		Path = "game/src/ServerStorage/Classes/Services/ShopService.luau",
		Kind = "service",
		Source = string.gsub(ShopSource, "\n", LineEnding),
	}
	local Hud = {
		Path = "game/src/ReplicatedStorage/Classes/Controllers/HudController.luau",
		Kind = "controller",
		Source = string.gsub(HudSource, "\n", LineEnding),
	}
	return if Order == "ShopFirst" then { Shop, Hud } else { Hud, Shop }
end

Describe("ManifestBuilder", function()
	It("counts lines like the module size check does", function()
		Expect(ManifestBuilder.CountLines("")).ToBe(0)
		Expect(ManifestBuilder.CountLines("a")).ToBe(1)
		Expect(ManifestBuilder.CountLines("a\nb\n")).ToBe(2)
		Expect(ManifestBuilder.CountLines("a\r\nb\r\n")).ToBe(2)
	end)

	It("describes each module with its Init, Start and sorted unique packets", function()
		local Manifest = ManifestBuilder.Build(Files("ShopFirst", "\n"), Packets)
		Expect(Manifest.manifestVersion).ToBe(1)
		Expect(Manifest.modules[1]).ToEqual({
			name = "HudController",
			kind = "controller",
			path = "game/src/ReplicatedStorage/Classes/Controllers/HudController.luau",
			lineCount = 5,
			hasInit = false,
			hasStart = true,
			listens = {},
		})
		Expect(Manifest.modules[2].name).ToBe("ShopService")
		Expect(Manifest.modules[2].hasInit).ToBe(true)
		Expect(Manifest.modules[2].listens).ToEqual({ "Shop.Buy" })
	end)

	It("describes packets in name order with a null rate limit for outbound ones", function()
		local Manifest = ManifestBuilder.Build(Files("ShopFirst", "\n"), Packets)
		Expect(Manifest.packets[1]).ToEqual({
			name = "Shop.Buy",
			direction = "ClientToServer",
			payload = "{ ItemId: enum ItemId }",
			rateLimit = { capacity = 3, refillPerSecond = 1 },
		})
		Expect(Manifest.packets[2].rateLimit).ToBe(JsonEncode.Null)
	end)

	It("gives the same bytes for shuffled input and CRLF sources", function()
		local Normal = JsonEncode.Encode(ManifestBuilder.Build(Files("ShopFirst", "\n"), Packets))
		local Shuffled = JsonEncode.Encode(ManifestBuilder.Build(Files("HudFirst", "\r\n"), { Packets[2], Packets[1] }))
		Expect(Shuffled).ToBe(Normal)
		Expect(string.find(Normal, "\r", 1, true)).ToBeNil()
	end)
end)

return nil
