--!strict
local Harness = require("@Tests/Harness")
local ItemId = require("@Shared/Enums/ItemId")
local Packets = require("@Shared/Net/Packets")
local Validate = require("@Logic/Net/Validate")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

local Enums = { ItemId = ItemId }

Describe("Packets", function()
	It("has unique names, listed in name order, all shaped like Area.Action", function()
		local Seen = {}
		for Index, Def in Packets.List do
			Expect(Seen[Def.Name]).ToBeNil()
			Seen[Def.Name] = true
			Expect(string.match(Def.Name, "^%u%a*%.%u%a*$") ~= nil).ToBe(true)
			Expect(Packets.ByName[Def.Name]).ToBe(Def)
			if Index > 1 then
				Expect(Packets.List[Index - 1].Name < Def.Name).ToBe(true)
			end
		end
	end)

	It("gives every client to server packet a rate limit and a payload that compiles", function()
		for _, Def in Packets.List do
			Expect(Def.Direction == "ClientToServer" or Def.Direction == "ServerToClient").ToBe(true)
			Validate.FromSpec(Def.Payload :: any, Enums)
			if Def.Direction == "ClientToServer" then
				local Limit = Def.RateLimit
				Expect(Limit ~= nil).ToBe(true)
			else
				Expect(Def.RateLimit).ToBeNil()
			end
		end
	end)

	It("Shop.Buy only carries an ItemId, so a price can never come from the client", function()
		local Payload = Packets.ByName["Shop.Buy"].Payload
		Expect(Payload.Kind).ToBe("Struct")
		local FieldNames = {}
		for Name in Payload.Fields do
			table.insert(FieldNames, Name)
		end
		Expect(FieldNames).ToEqual({ "ItemId" })
	end)
end)

return nil
