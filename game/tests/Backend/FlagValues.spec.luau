--!strict
local Fs = require("@lune/fs")
local Harness = require("@Tests/Harness")
local FlagValues = require("@Logic/Backend/FlagValues")
local Flags = require("@Configs/Flags")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

-- selene: allow(divide_by_zero)
local NaN = 0 / 0
local Defaults = { ShopEnabled = true, OrbSpawnMultiplier = 1 }

-- Collects every key and value pair a pattern finds. A key seen twice means the source is not
-- shaped the way this spec expects, so it fails loudly.
local function ReadPairs(Text: string, Pattern: string): { [string]: string }
	local Found: { [string]: string } = {}
	for Key, Value in string.gmatch(Text, Pattern) do
		assert(Found[Key] == nil, `{Key} shows up twice`)
		Found[Key] = Value
	end
	return Found
end

local function Reply(Status: number, Body: any?)
	return { Ok = Status >= 200 and Status < 300, Status = Status, Body = Body, Headers = {} }
end

Describe("FlagValues.Merge", function()
	It("takes known flags whose type matches the default", function()
		Expect(FlagValues.Merge(Defaults, Defaults, { ShopEnabled = false, OrbSpawnMultiplier = 2 })).ToEqual({
			ShopEnabled = false,
			OrbSpawnMultiplier = 2,
		})
	end)

	It("ignores unknown flags", function()
		local Merged = FlagValues.Merge(Defaults, Defaults, { Unknown = true, ShopEnabled = false })
		Expect(Merged).ToEqual({ ShopEnabled = false, OrbSpawnMultiplier = 1 })
		Expect(Merged.Unknown).ToBeNil()
	end)

	It("a wrong type, NaN or an endless number falls back to the default, not the last value", function()
		local Current = { ShopEnabled = false, OrbSpawnMultiplier = 3 }
		Expect(FlagValues.Merge(Defaults, Current, { ShopEnabled = "no", OrbSpawnMultiplier = NaN })).ToEqual(Defaults)
		Expect(FlagValues.Merge(Defaults, Current, { ShopEnabled = 0, OrbSpawnMultiplier = math.huge })).ToEqual(
			Defaults
		)
		Expect(FlagValues.Merge(Defaults, Current, { OrbSpawnMultiplier = -math.huge }).OrbSpawnMultiplier).ToBe(1)
		Expect(FlagValues.Merge(Defaults, Current, { OrbSpawnMultiplier = "2" }).OrbSpawnMultiplier).ToBe(1)
	end)

	It("keeps the last known values when the reply is missing or broken", function()
		local Current = { ShopEnabled = false, OrbSpawnMultiplier = 3 }
		Expect(FlagValues.Merge(Defaults, Current, nil)).ToEqual(Current)
		Expect(FlagValues.Merge(Defaults, Current, "flags")).ToEqual(Current)
		Expect(FlagValues.Merge(Defaults, Current, { OrbSpawnMultiplier = 2 })).ToEqual({
			ShopEnabled = false,
			OrbSpawnMultiplier = 2,
		})
	end)

	It("never hands back the caller's table, and fills a flag Current lacks from the defaults", function()
		local Current = { ShopEnabled = false }
		local Merged = FlagValues.Merge(Defaults, Current, nil)
		Expect(Merged == Current).ToBe(false)
		Expect(Merged).ToEqual({ ShopEnabled = false, OrbSpawnMultiplier = 1 })
		Expect(FlagValues.Merge(Defaults, { ShopEnabled = "bad", Stray = 1 }, nil)).ToEqual(Defaults)
	end)
end)

Describe("FlagValues.FromResponse", function()
	local Current = { ShopEnabled = false, OrbSpawnMultiplier = 3 }

	It("a 200 with flags merges them", function()
		Expect(FlagValues.FromResponse(Defaults, Current, Reply(200, { flags = { ShopEnabled = true } }))).ToEqual({
			ShopEnabled = true,
			OrbSpawnMultiplier = 3,
		})
	end)

	It("a 503 flags_unavailable, no answer or a broken body keeps the last good values", function()
		local Unavailable = Reply(503, { error = "flags_unavailable", message = "Flags are temporarily unavailable" })
		Expect(FlagValues.FromResponse(Defaults, Current, Unavailable)).ToEqual(Current)
		Expect(FlagValues.FromResponse(Defaults, Current, Reply(0))).ToEqual(Current)
		Expect(FlagValues.FromResponse(Defaults, Current, Reply(-1))).ToEqual(Current)
		Expect(FlagValues.FromResponse(Defaults, Current, Reply(200, "oops"))).ToEqual(Current)
		Expect(FlagValues.FromResponse(Defaults, Current, Reply(200, { flags = 5 }))).ToEqual(Current)
		-- Only a 200 is a flags reply, even if some other answer happens to carry a flags table.
		Expect(FlagValues.FromResponse(Defaults, Current, Reply(201, { flags = { ShopEnabled = true } }))).ToEqual(
			Current
		)
	end)
end)

Describe("Configs/Flags", function()
	It("has the typed fallback values and is frozen", function()
		Expect(Flags.ShopEnabled).ToBe(true)
		Expect(Flags.OrbSpawnMultiplier).ToBe(1)
		Expect(Flags.TelemetryEnabled).ToBe(true)
		Expect(table.isfrozen(Flags)).ToBe(true)
	end)

	It("matches FLAG_DEFAULTS in flagsService.ts and the seed rows in migration 005", function()
		local Service = Fs.readFile("../backend/src/modules/flags/flagsService.ts")
		local Body = string.match(Service, "FLAG_DEFAULTS[^=]*= Object%.freeze%(%{(.-)%}%)")
		assert(Body ~= nil, "FLAG_DEFAULTS is missing from flagsService.ts")
		local FromService = ReadPairs(Body, "(%w+):%s*([%w%.]+)")
		local Seed = Fs.readFile("../backend/migrations/005_flags.sql")
		local FromSeed = ReadPairs(Seed, "%('(%w+)', CAST%('([^']*)' AS JSON%)")
		local Count = 0
		for Key, Value in pairs(Flags :: any) do
			Count += 1
			Expect(FromService[Key]).ToBe(tostring(Value))
			Expect(FromSeed[Key]).ToBe(tostring(Value))
		end
		for Key in FromService do
			Expect((Flags :: any)[Key] ~= nil).ToBe(true)
		end
		for Key in FromSeed do
			Expect((Flags :: any)[Key] ~= nil).ToBe(true)
		end
		Expect(Count).ToBe(3)
	end)
end)

return nil
