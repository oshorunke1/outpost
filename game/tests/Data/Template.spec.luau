--!strict
local Harness = require("@Tests/Harness")
local Migrations = require("@Logic/Data/Migrations")
local Migrator = require("@Logic/Data/Migrator")
local Template = require("@Logic/Data/Template")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

Describe("Template", function()
	It("SchemaVersion is one more than the number of migrations", function()
		Expect(Template.SchemaVersion).ToBe(#Migrations + 1)
	end)

	It("Defaults carry the current SchemaVersion", function()
		Expect(Template.Defaults.SchemaVersion).ToBe(Template.SchemaVersion)
	end)

	It("Fresh hands out a new table every time", function()
		local First = Template.Fresh()
		local Second = Template.Fresh()
		First.OwnedItems.RedHat = true
		First.Stats.OrbsCollected = 3
		Expect(Second.OwnedItems.RedHat).ToBeNil()
		Expect(Second.Stats.OrbsCollected).ToBe(0)
	end)

	It("a fresh save needs no migration", function()
		local Outcome = Migrator.Run(Template.Fresh(), Migrations)
		Expect(Outcome.Ok).ToBe(true)
		Expect(Outcome.Data).ToEqual(Template.Fresh())
	end)
end)

return nil
