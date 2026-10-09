--!strict
local Harness = require("@Tests/Harness")
local BackendClient = require("@Logic/Backend/BackendClient")
local BackendMode = require("@Logic/Backend/BackendMode")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

-- A secret lookup that counts how often it was asked.
local function Lookup(Found: boolean): (() -> boolean, () -> number)
	local Calls = 0
	return function()
		Calls += 1
		return Found
	end, function()
		return Calls
	end
end

Describe("BackendMode.Pick", function()
	It("Studio always uses the mock, turned on or not, and never asks for the secret", function()
		for _, Enabled in { true, false } do
			local Find, Calls = Lookup(true)
			Expect(BackendMode.Pick(true, Enabled, Find)).ToBe("Mock")
			Expect(Calls()).ToBe(0)
		end
	end)

	It("a live server with the backend turned off sends nothing and never asks for the secret", function()
		local Find, Calls = Lookup(true)
		Expect(BackendMode.Pick(false, false, Find)).ToBe("Offline")
		Expect(Calls()).ToBe(0)
	end)

	It("a live server that is turned on and has the secret talks to the backend", function()
		local Find, Calls = Lookup(true)
		Expect(BackendMode.Pick(false, true, Find)).ToBe("Roblox")
		Expect(Calls()).ToBe(1)
	end)

	It("a live server that is turned on but has no secret sends nothing", function()
		local Find = Lookup(false)
		Expect(BackendMode.Pick(false, true, Find)).ToBe("Offline")
	end)

	It("a live server never runs on the in-memory mock, whatever the settings", function()
		for _, Enabled in { true, false } do
			for _, Found in { true, false } do
				local Find = Lookup(Found)
				Expect(BackendMode.Pick(false, Enabled, Find) ~= "Mock").ToBe(true)
			end
		end
	end)
end)

Describe("BackendMode.Offline", function()
	It("answers every request at once with the Offline refusal and a fresh table", function()
		local First = BackendMode.Offline({ Method = "GET", Url = "https://x.test/v1/flags", Headers = {} })
		Expect(First.Ok).ToBe(false)
		-- A refusal below zero, so BackendClient neither retries it nor counts it against a breaker.
		Expect(First.Status).ToBe(BackendClient.Offline)
		Expect(BackendMode.OfflineStatus).ToBe(BackendClient.Offline)
		Expect(First.Body).ToBeNil()
		First.Headers.x = "y"
		local Second = BackendMode.Offline({ Method = "GET", Url = "https://x.test/v1/flags", Headers = {} })
		Expect(Second.Headers.x).ToBeNil()
	end)
end)

Describe("BackendMode.EconomyLive", function()
	It(
		"the ledger runs the economy only on a live server that talks to the backend, or on Studio's mock when opted in",
		function()
			local Cases: { { Mode: BackendMode.Mode, StudioLedger: boolean, Live: boolean } } = {
				{ Mode = "Roblox", StudioLedger = false, Live = true },
				{ Mode = "Roblox", StudioLedger = true, Live = true },
				{ Mode = "Mock", StudioLedger = false, Live = false },
				{ Mode = "Mock", StudioLedger = true, Live = true },
				{ Mode = "Offline", StudioLedger = false, Live = false },
				{ Mode = "Offline", StudioLedger = true, Live = false },
			}
			for _, Case in Cases do
				Expect(BackendMode.EconomyLive(Case.Mode, Case.StudioLedger)).ToBe(Case.Live)
			end
		end
	)
end)

Describe("BackendMode.ForceMockSaves", function()
	It("the Studio opt in also keeps saves in memory, and nothing else does", function()
		Expect(BackendMode.ForceMockSaves(true, true)).ToBe(true)
		Expect(BackendMode.ForceMockSaves(true, false)).ToBe(false)
		Expect(BackendMode.ForceMockSaves(false, true)).ToBe(false)
		Expect(BackendMode.ForceMockSaves(false, false)).ToBe(false)
	end)
end)

return nil
