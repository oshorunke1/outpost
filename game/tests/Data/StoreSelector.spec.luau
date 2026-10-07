--!strict
local Harness = require("@Tests/Harness")
local Places = require("@Configs/Places")
local StoreSelector = require("@Logic/Data/StoreSelector")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

local Fake = { Live = 111, Test = { 222, 333 } }

Describe("StoreSelector.Choose", function()
	It("uses the Live store on the live place in a real server", function()
		Expect(StoreSelector.Choose(111, false, Fake)).ToEqual({ Kind = "Live", StoreName = "Outpost_Players_Live" })
	end)

	It("never lets Studio touch live saves", function()
		Expect(StoreSelector.Choose(111, true, Fake).Kind).ToBe("Mock")
	end)

	It("uses the Test store on a test place, in Studio too", function()
		Expect(StoreSelector.Choose(222, false, Fake)).ToEqual({ Kind = "Test", StoreName = "Outpost_Players_Test" })
		Expect(StoreSelector.Choose(333, true, Fake).Kind).ToBe("Test")
	end)

	It("treats unknown and unpublished places as Mock in Studio and Test on a server", function()
		Expect(StoreSelector.Choose(0, true, Fake)).ToEqual({ Kind = "Mock", StoreName = "Outpost_Players_Mock" })
		Expect(StoreSelector.Choose(0, false, Fake).Kind).ToBe("Test")
		Expect(StoreSelector.Choose(999, false, Fake).Kind).ToBe("Test")
	end)

	It("ForceMock always wins", function()
		Expect(StoreSelector.Choose(111, false, Fake, true).Kind).ToBe("Mock")
		Expect(StoreSelector.Choose(222, false, Fake, true).Kind).ToBe("Mock")
	end)

	It("place 0 is never Live, even when the registry still says Live is 0", function()
		Expect(StoreSelector.Choose(0, false, { Live = 0, Test = {} }).Kind).ToBe("Test")
	end)

	It("the real M1 registry never picks Live", function()
		for _, PlaceId in { 0, 1, 987654321 } do
			Expect(StoreSelector.Choose(PlaceId, false, Places).Kind ~= "Live").ToBe(true)
		end
	end)
end)

return nil
