--!strict
local Harness = require("@Tests/Harness")
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
	It("answers every request with Status 0 and a fresh table", function()
		local First = BackendMode.Offline({ Method = "GET", Url = "https://x.test/v1/flags", Headers = {} })
		Expect(First.Ok).ToBe(false)
		Expect(First.Status).ToBe(0)
		Expect(First.Body).ToBeNil()
		First.Headers.x = "y"
		local Second = BackendMode.Offline({ Method = "GET", Url = "https://x.test/v1/flags", Headers = {} })
		Expect(Second.Headers.x).ToBeNil()
	end)
end)

return nil
