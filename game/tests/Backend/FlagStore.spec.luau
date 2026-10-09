--!strict
local Harness = require("@Tests/Harness")
local MockClient = require("@Tests/Backend/MockClient")
local FlagStore = require("@Logic/Backend/FlagStore")
local FlagValues = require("@Logic/Backend/FlagValues")
local Requests = require("@Logic/Backend/Requests")
local Flags = require("@Configs/Flags")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

local function NewStore(Rig: any, Live: boolean?)
	return FlagStore.new({
		Defaults = Flags,
		FromResponse = FlagValues.FromResponse,
		Client = Rig.Client,
		Request = Requests.Flags,
		Live = Live ~= false,
	})
end

Describe("FlagStore", function()
	It("serves the defaults before the first poll", function()
		local Store = NewStore(MockClient.new())
		Expect(Store:Value("ShopEnabled")).ToBe(true)
		Expect(Store:Value("OrbSpawnMultiplier")).ToBe(1)
		Expect(Store:Value("TelemetryEnabled")).ToBe(true)
		Expect(Store:Value("NoSuchFlag")).ToBeNil()
	end)

	It("a poll takes the backend's values", function()
		local Rig = MockClient.new()
		local Store = NewStore(Rig)
		Rig.Controls.SetFlag("ShopEnabled", false)
		Rig.Controls.SetFlag("OrbSpawnMultiplier", 2)
		Expect(Store:Poll()).ToBe(true)
		Expect(Store:Value("ShopEnabled")).ToBe(false)
		Expect(Store:Value("OrbSpawnMultiplier")).ToBe(2)
		Expect(#Rig.Sent("/v1/flags")).ToBe(1)
	end)

	It("keeps the last known values when the backend is down", function()
		local Rig = MockClient.new()
		local Store = NewStore(Rig)
		Rig.Controls.SetFlag("ShopEnabled", false)
		Store:Poll()
		Rig.Controls.SetFlag("ShopEnabled", true)
		Rig.Controls.FailNext(503, "flags_unavailable", nil, 10)
		Expect(Store:Poll()).ToBe(false)
		Expect(Store:Value("ShopEnabled")).ToBe(false)
	end)

	It("a flag with the wrong type goes back to its default", function()
		local Rig = MockClient.new()
		local Store = NewStore(Rig)
		Rig.Controls.SetFlag("OrbSpawnMultiplier", "fast")
		Store:Poll()
		Expect(Store:Value("OrbSpawnMultiplier")).ToBe(1)
	end)

	It("an Offline server sends nothing and keeps the defaults", function()
		local Rig = MockClient.new()
		local Store = NewStore(Rig, false)
		Rig.Controls.SetFlag("ShopEnabled", false)
		Expect(Store:Poll()).ToBe(false)
		Expect(#Rig.Sends).ToBe(0)
		Expect(Store:Value("ShopEnabled")).ToBe(true)
	end)

	It("a client that throws keeps the last known values", function()
		local Store = FlagStore.new({
			Defaults = Flags,
			FromResponse = FlagValues.FromResponse,
			Client = {
				Send = function()
					error("boom")
				end,
			},
			Request = Requests.Flags,
			Live = true,
		})
		Expect(Store:Poll()).ToBe(false)
		Expect(Store:Value("ShopEnabled")).ToBe(true)
	end)
end)

return nil
