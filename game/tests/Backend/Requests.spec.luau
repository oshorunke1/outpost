--!strict
local Harness = require("@Tests/Harness")
local Requests = require("@Logic/Backend/Requests")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

-- selene: allow(divide_by_zero)
local NaN = 0 / 0

Describe("Requests", function()
	It("player routes put the UserId in the path as plain digits, even when it is huge", function()
		Expect(Requests.JoinSession(1001).Path).ToBe("/v1/players/1001/sessions")
		Expect(Requests.LeaveSession(1001).Path).ToBe("/v1/players/1001/sessions/end")
		Expect(Requests.Wallet(9007199254740991).Path).ToBe("/v1/players/9007199254740991/wallet")
		Expect(Requests.Unfulfilled(1001).Path).ToBe("/v1/players/1001/purchases?unfulfilled=1")
	end)

	It("an earn carries its idempotency key and the amount, never a price", function()
		local Request = Requests.Earn(1001, 35, "job-1:1001:4")
		Expect(Request.Method).ToBe("POST")
		Expect(Request.Path).ToBe("/v1/economy/transactions")
		Expect((Request.Headers :: any)["Idempotency-Key"]).ToBe("job-1:1001:4")
		Expect(Request.Body).ToEqual({ kind = "earn", userId = 1001, amount = 35, reason = "orbs" })
	end)

	It("a legacy credit is an earn with the legacy_migration reason under a fixed key", function()
		local Request = Requests.LegacyCredit(1001, 1000, 1)
		Expect(Request.Path).ToBe("/v1/economy/transactions")
		Expect((Request.Headers :: any)["Idempotency-Key"]).ToBe("legacy-1001-1")
		Expect(Request.Body).ToEqual({ kind = "earn", userId = 1001, amount = 1000, reason = "legacy_migration" })
		Expect(Requests.LegacyKey(9007199254740991, 12)).ToBe("legacy-9007199254740991-12")
		-- The shortest UserId still gives a key the backend's 8 character rule accepts.
		Expect(Requests.IsIdempotencyKey(Requests.LegacyKey(1, 1))).ToBe(true)
	end)

	It("a legacy key refuses a bad UserId or chunk number instead of colliding with another", function()
		for _, Bad in { 0, -1, 1.5, NaN, math.huge } do
			Expect(function()
				Requests.LegacyKey(Bad, 1)
			end).ToThrow("UserId")
			Expect(function()
				Requests.LegacyKey(1001, Bad)
			end).ToThrow("chunk")
		end
	end)

	It("a purchase names only the item", function()
		Expect(Requests.Purchase(1001, "RedHat", "key-12345").Body).ToEqual({
			kind = "purchase",
			userId = 1001,
			itemId = "RedHat",
		})
	end)

	It("POSTs without a payload still send an empty JSON body", function()
		Expect(Requests.JoinSession(1).Body).ToEqual({})
		Expect(Requests.LeaveSession(1).Body).ToEqual({})
		Expect(Requests.ServiceToken().Body).ToEqual({})
		Expect(Requests.ServiceToken().Path).ToBe("/auth/service-token")
	end)

	It("GETs send no body at all", function()
		Expect(Requests.Wallet(1).Body).ToBeNil()
		Expect(Requests.Unfulfilled(1).Body).ToBeNil()
		Expect(Requests.Flags().Body).ToBeNil()
	end)

	It("fulfilled refuses anything that is not a transaction id", function()
		Expect(Requests.Fulfilled("00000000-0000-4000-8000-000000000001").Path).ToBe(
			"/v1/economy/transactions/00000000-0000-4000-8000-000000000001/fulfilled"
		)
		Expect(function()
			Requests.Fulfilled("../../admin")
		end).ToThrow("not a transaction id")
	end)

	It("telemetry and flags", function()
		local Events = { { name = "player_join", ts = 1, userId = 1001 } }
		Expect(Requests.TelemetryBatch(Events).Body).ToEqual({ events = Events })
		Expect(Requests.TelemetryBatch(Events).Path).ToBe("/v1/telemetry/batch")
		Expect(Requests.Flags().Path).ToBe("/v1/flags")
	end)
end)

-- S6-F7. A UserId that is not a whole number from 1 up would build a path for some other player,
-- because string.format with %d quietly cuts 1.5 down to 1.
Describe("Requests refuse a bad UserId", function()
	local Builders: { [string]: (UserId: any) -> any } = {
		JoinSession = Requests.JoinSession,
		LeaveSession = Requests.LeaveSession,
		Wallet = Requests.Wallet,
		Unfulfilled = Requests.Unfulfilled,
		Earn = function(UserId: any)
			return Requests.Earn(UserId, 5, "job-1:1:1")
		end,
		Purchase = function(UserId: any)
			return Requests.Purchase(UserId, "RedHat", "key-12345")
		end,
	}

	for Name, Build in Builders do
		It(`{Name} refuses 1.5, 0, -3, NaN, infinity, a too big id and non numbers`, function()
			for _, Bad in { 1.5, 0, -3, NaN, math.huge, -math.huge, 9007199254740992, "1001", nil, true } :: { any } do
				Expect(function()
					Build(Bad)
				end).ToThrow("is not a UserId")
			end
		end)
	end

	It("the largest safe UserId is still fine", function()
		Expect(Requests.Earn(9007199254740991, 1, "job-1:1:1").Body.userId).ToBe(9007199254740991)
	end)
end)

Describe("Requests refuse a bad transaction id", function()
	It("accepts the exact 8-4-4-4-12 hex shape in either case", function()
		Expect(Requests.Fulfilled("ABCDEF01-2345-4789-89AB-CDEF01234567").Path).ToBe(
			"/v1/economy/transactions/ABCDEF01-2345-4789-89AB-CDEF01234567/fulfilled"
		)
		Expect(Requests.Fulfilled("abcdef01-2345-4789-89ab-cdef01234567").Method).ToBe("POST")
	end)

	-- Task 25 fix M5. The backend checks ids with zod's uuid rule, so we match it exactly.
	-- The third group starts with a version from 1 to 8 and the fourth with a variant of 8, 9, a or b.
	-- The all zero and all f ids are allowed as special cases, the all f one only in lowercase.
	It("follows the backend's uuid rule for version, variant and the two special ids", function()
		for _, Good in
			{
				"00000000-0000-1000-8000-000000000000",
				"00000000-0000-8000-b000-000000000000",
				"00000000-0000-4000-A000-000000000000",
				"00000000-0000-0000-0000-000000000000",
				"ffffffff-ffff-ffff-ffff-ffffffffffff",
			}
		do
			Expect(Requests.Fulfilled(Good).Method).ToBe("POST")
		end
		for _, Bad in
			{
				"00000000-0000-0000-8000-000000000001",
				"00000000-0000-9000-8000-000000000001",
				"00000000-0000-4000-7000-000000000001",
				"00000000-0000-4000-c000-000000000001",
				"FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
				"ffffffff-ffff-ffff-ffff-fffffffffffe",
			}
		do
			Expect(function()
				Requests.Fulfilled(Bad)
			end).ToThrow("not a transaction id")
		end
	end)

	It("refuses dashes only, wrong group lengths, non hex and extra text", function()
		for _, Bad in
			{
				"----",
				"",
				"00000000-0000-4000-8000-00000000001",
				"00000000-0000-4000-8000-0000000000011",
				"0000000-00000-4000-8000-000000000001",
				"00000000000040008000000000000001",
				"g0000000-0000-4000-8000-000000000001",
				"00000000-0000-4000-8000-000000000001/../x",
				" 00000000-0000-4000-8000-000000000001",
				"00000000-0000-4000-8000-000000000001\n",
			}
		do
			Expect(function()
				Requests.Fulfilled(Bad)
			end).ToThrow("not a transaction id")
		end
		Expect(function()
			Requests.Fulfilled((42 :: any) :: string)
		end).ToThrow("not a transaction id")
	end)
end)

Describe("Requests idempotency keys", function()
	It("Earn and Purchase refuse a key the backend would reject", function()
		for _, Bad in { "short", "seven77", "", "has space 123", "slash/12345", string.rep("a", 129), "ünïcode-key" } do
			Expect(function()
				Requests.Earn(1, 5, Bad)
			end).ToThrow("not an idempotency key")
			Expect(function()
				Requests.Purchase(1, "RedHat", Bad)
			end).ToThrow("not an idempotency key")
		end
		Expect(Requests.IsIdempotencyKey(string.rep("a", 128))).ToBe(true)
		Expect(Requests.IsIdempotencyKey("A_b-1:2:3")).ToBe(true)
		Expect(Requests.IsIdempotencyKey("eight888")).ToBe(true)
		Expect(Requests.IsIdempotencyKey("seven77")).ToBe(false)
		Expect(Requests.IsIdempotencyKey((nil :: any) :: string)).ToBe(false)
	end)

	It("a boot tag uses the cleaned JobId when there is one", function()
		Expect(Requests.BootTag("9f1c2d3e-0000-4000-8000-000000000abc", "0badf00d")).ToBe(
			"9f1c2d3e-0000-4000-8000-000000000abc"
		)
		Expect(Requests.BootTag("job {1}: bad/chars", "0badf00d")).ToBe("job1badchars")
	end)

	It("a boot tag falls back to the random nonce when the JobId is empty, like in Studio", function()
		Expect(Requests.BootTag("", "0badf00d")).ToBe("boot-0badf00d")
		Expect(Requests.BootTag(nil, "0badf00d")).ToBe("boot-0badf00d")
		Expect(Requests.BootTag("::", "0badf00d")).ToBe("boot-0badf00d")
	end)

	It("a boot tag refuses a nonce that is not 8 to 32 hex characters", function()
		for _, Bad in { "", "abc", "not-hex!", string.rep("a", 33) } do
			Expect(function()
				Requests.BootTag("", Bad)
			end).ToThrow("nonce")
		end
	end)

	It("a very long JobId is cut so the key still fits", function()
		local Tag = Requests.BootTag(string.rep("x", 200), "0badf00d")
		Expect(#Tag).ToBe(64)
		Expect(Requests.IsIdempotencyKey(Requests.IdempotencyKey(Tag, "9007199254740991", 9007199254740991))).ToBe(true)
	end)

	It("keys join the boot tag, a scope and a counter, and always pass the backend's rule", function()
		local Key = Requests.IdempotencyKey("boot-0badf00d", "1001", 4)
		Expect(Key).ToBe("boot-0badf00d:1001:4")
		Expect(Requests.IsIdempotencyKey(Key)).ToBe(true)
		Expect(function()
			Requests.IdempotencyKey("boot-0badf00d", "bad scope", 1)
		end).ToThrow("not an idempotency key")
		Expect(function()
			Requests.IdempotencyKey("boot-0badf00d", "1001", 1.5)
		end).ToThrow("counter")
	end)

	-- S6-F8. Two Studio boots both have an empty JobId and both count from 1, so without the
	-- nonce their keys would be the same and the backend would answer the second with a 409.
	It("two boots never collide, even with the same empty JobId and the same counters", function()
		local FirstBoot = Requests.BootTag("", "1a2b3c4d")
		local SecondBoot = Requests.BootTag("", "5e6f7a8b")
		local Seen: { [string]: boolean } = {}
		for _, Tag in { FirstBoot, SecondBoot } do
			for Counter = 1, 50 do
				local Key = Requests.IdempotencyKey(Tag, "1001", Counter)
				Expect(Seen[Key]).ToBeNil()
				Seen[Key] = true
			end
		end
	end)
end)

return nil
