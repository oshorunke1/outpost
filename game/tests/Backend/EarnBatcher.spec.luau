--!strict
local Harness = require("@Tests/Harness")
local EarnBatcher = require("@Logic/Backend/EarnBatcher")
local Requests = require("@Logic/Backend/Requests")
local RetryPolicy = require("@Logic/Backend/RetryPolicy")
local Fs = require("@lune/fs")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

type Flush = EarnBatcher.Flush

-- selene: allow(divide_by_zero)
local NaN = 0 / 0

local Tag = "boot-0badf00d"

type Options = { MaxCoins: number?, MaxAgeSeconds: number?, Unit: number?, Policy: EarnBatcher.Policy? }

local function Make(Options: Options?): EarnBatcher.EarnBatcher
	local Given: Options = Options or {}
	return EarnBatcher.new({
		BootTag = Tag,
		MaxCoins = Given.MaxCoins or 200,
		MaxAgeSeconds = Given.MaxAgeSeconds or 30,
		Keys = Requests,
		Retry = RetryPolicy,
		Policy = Given.Policy,
		RandomUnit = function()
			return Given.Unit or 1
		end,
	})
end

-- Just the parts a test usually cares about, so expected tables stay short.
local function Brief(List: { Flush }): { { any } }
	local Out = {}
	for _, Flush in List do
		table.insert(Out, { Flush.UserId, Flush.Coins, Flush.Key })
	end
	return Out
end

Describe("EarnBatcher setup", function()
	It("refuses a MaxCoins outside 1 to the server's 1000", function()
		for _, Bad in { 0, -5, 1001, 2.5, NaN, math.huge } do
			Expect(function()
				Make({ MaxCoins = Bad })
			end).ToThrow("MaxCoins")
		end
		Make({ MaxCoins = 1 })
		Make({ MaxCoins = 1000 })
	end)

	It("refuses a MaxAgeSeconds that is not a finite positive number", function()
		for _, Bad in { 0, -1, NaN, math.huge, -math.huge } do
			Expect(function()
				Make({ MaxAgeSeconds = Bad })
			end).ToThrow("MaxAgeSeconds")
		end
		Make({ MaxAgeSeconds = 0.5 })
	end)

	It("refuses a boot tag the backend's key rule would refuse", function()
		Expect(function()
			EarnBatcher.new({
				BootTag = "has a space",
				MaxCoins = 200,
				MaxAgeSeconds = 30,
				Keys = Requests,
				Retry = RetryPolicy,
				RandomUnit = math.random,
			})
		end).ToThrow("idempotency key")
	end)

	It("the 1000 cap matches MAX_EARN_PER_TRANSACTION in the backend", function()
		local Plan = Fs.readFile("../backend/src/modules/economy/plan.ts")
		local Server = tonumber(string.match(Plan, "export const MAX_EARN_PER_TRANSACTION = (%d+);"))
		Expect(EarnBatcher.MaxEarnPerTransaction).ToBe(Server)
	end)
end)

Describe("EarnBatcher batching", function()
	It("hands out a batch when a player reaches MaxCoins exactly", function()
		local Batcher = Make()
		for _ = 1, 39 do
			Expect(#Batcher:Add(1001, 5, 0)).ToBe(0)
		end
		Expect(Brief(Batcher:Add(1001, 5, 0))).ToEqual({ { 1001, 200, `{Tag}:1001:1` } })
		Expect(Batcher:PendingCoins(1001)).ToBe(0)
	end)

	It("sends what it has before an add would pass MaxCoins, so 150 then 900 is two batches", function()
		local Batcher = Make({ MaxCoins = 1000 })
		Expect(#Batcher:Add(1001, 150, 0)).ToBe(0)
		Expect(Brief(Batcher:Add(1001, 900, 1))).ToEqual({ { 1001, 150, `{Tag}:1001:1` } })
		Expect(Batcher:PendingCoins(1001)).ToBe(900)
		Expect(Brief({ Batcher:TakeFor(1001) :: Flush })).ToEqual({ { 1001, 900, `{Tag}:1001:2` } })
	end)

	It("splits a single add of 2500 into full batches and keeps the rest", function()
		local Batcher = Make({ MaxCoins = 1000 })
		Expect(Brief(Batcher:Add(1001, 2500, 0))).ToEqual({
			{ 1001, 1000, `{Tag}:1001:1` },
			{ 1001, 1000, `{Tag}:1001:2` },
		})
		Expect(Batcher:PendingCoins(1001)).ToBe(500)

		local Other = Make({ MaxCoins = 1000 })
		Other:Add(7, 300, 0)
		Expect(Brief(Other:Add(7, 2500, 0))).ToEqual({
			{ 7, 300, `{Tag}:7:1` },
			{ 7, 1000, `{Tag}:7:2` },
			{ 7, 1000, `{Tag}:7:3` },
		})
		Expect(Other:PendingCoins(7)).ToBe(500)
	end)

	It("no batch ever goes over MaxCoins", function()
		local Batcher = Make({ MaxCoins = 1000 })
		local Total = 0
		local Sent = 0
		for Step = 1, 200 do
			local Coins = (Step * 37) % 1300 + 1
			Total += Coins
			for _, Flush in Batcher:Add(1001, Coins, Step) do
				Expect(Flush.Coins >= 1 and Flush.Coins <= 1000).ToBe(true)
				Sent += Flush.Coins
			end
		end
		Expect(Sent + Batcher:PendingCoins(1001)).ToBe(Total)
	end)

	It("flushes a batch once its first Coin is MaxAgeSeconds old", function()
		local Batcher = Make()
		Batcher:Add(1001, 5, 0)
		Batcher:Add(1002, 5, 10)
		Expect(#Batcher:TakeDue(29)).ToBe(0)
		Expect(Brief(Batcher:TakeDue(30))).ToEqual({ { 1001, 5, `{Tag}:1001:1` } })
		Expect(Brief(Batcher:TakeDue(40))).ToEqual({ { 1002, 5, `{Tag}:1002:1` } })
	end)

	It("the age starts again with the batch that follows an early send", function()
		local Batcher = Make({ MaxCoins = 1000 })
		Batcher:Add(1001, 150, 0)
		Batcher:Add(1001, 900, 10)
		Expect(#Batcher:TakeDue(39)).ToBe(0)
		Expect(Brief(Batcher:TakeDue(40))).ToEqual({ { 1001, 900, `{Tag}:1001:2` } })
	end)

	It("TakeFor sends a leaving player's Coins at once and the key counts up", function()
		local Batcher = Make()
		Batcher:Add(1001, 5, 0)
		Expect(Brief({ Batcher:TakeFor(1001) :: Flush })).ToEqual({ { 1001, 5, `{Tag}:1001:1` } })
		Expect(Batcher:TakeFor(1001)).ToBeNil()
		Batcher:Add(1001, 10, 1)
		Expect((Batcher:TakeFor(1001) :: Flush).Key).ToBe(`{Tag}:1001:2`)
	end)

	It("a fresh batch has had no tries yet", function()
		local Batcher = Make()
		Batcher:Add(1001, 5, 0)
		local Flush = Batcher:TakeFor(1001) :: Flush
		Expect(Flush.Attempts).ToBe(0)
	end)

	It("ignores Coins that are not a positive whole number", function()
		local Batcher = Make()
		for _, Bad in { NaN, -5, 0, 2.5, math.huge, -math.huge, "5" :: any } do
			Expect(#Batcher:Add(1001, Bad, 0)).ToBe(0)
		end
		Expect(Batcher:PendingCoins(1001)).ToBe(0)
	end)

	It("ignores a UserId the backend would refuse", function()
		local Batcher = Make()
		for _, Bad in { 0, -1, 1.5, NaN, math.huge, 2 ^ 53, "1001" :: any } do
			Expect(#Batcher:Add(Bad, 5, 0)).ToBe(0)
		end
		Expect(#Batcher:TakeAll()).ToBe(0)
	end)

	It("every key passes the backend rule and two boots never share one", function()
		local First = Make()
		local Second = EarnBatcher.new({
			BootTag = Requests.BootTag("", "0badf00e"),
			MaxCoins = 200,
			MaxAgeSeconds = 30,
			Keys = Requests,
			Retry = RetryPolicy,
			RandomUnit = math.random,
		})
		local Seen: { [string]: boolean } = {}
		for _, Batcher in { First, Second } do
			for UserId = 1, 20 do
				for _, Flush in Batcher:Add(UserId, 450, 0) do
					Expect(Requests.IsIdempotencyKey(Flush.Key)).ToBe(true)
					Expect(Seen[Flush.Key]).ToBeNil()
					Seen[Flush.Key] = true
				end
			end
		end
	end)

	It("TakeAll hands back everything, waiting retries included", function()
		local Batcher = Make()
		Batcher:Add(1001, 5, 0)
		Batcher:Add(1002, 7, 0)
		local Flush = Batcher:TakeFor(1001) :: Flush
		Batcher:Requeue(Flush, 503, 0)
		Expect(Brief(Batcher:TakeAll())).ToEqual({ { 1001, 5, `{Tag}:1001:1` }, { 1002, 7, `{Tag}:1002:1` } })
		Expect(#Batcher:TakeAll()).ToBe(0)
		Expect(Batcher:RetryCount()).ToBe(0)
	end)
end)

Describe("EarnBatcher retries", function()
	It("a requeued batch keeps its key and is not sent again before NextAttemptAt", function()
		local Batcher = Make()
		Batcher:Add(1001, 5, 0)
		local Flush = Batcher:TakeFor(1001) :: Flush
		local Outcome, Evicted = Batcher:Requeue(Flush, 503, 100)
		Expect(Outcome).ToBe("Queued")
		Expect(Evicted).ToBeNil()
		Expect(#Batcher:TakeDue(104.9)).ToBe(0)
		local Due = Batcher:TakeDue(105)
		Expect(Due).ToEqual({ { UserId = 1001, Coins = 5, Key = Flush.Key, Attempts = 1, NextAttemptAt = 105 } })
		Expect(#Batcher:TakeDue(1000)).ToBe(0)
	end)

	It("waits longer after each failure, up to the cap, then gives up and counts it", function()
		local Batcher = Make({ Policy = { MaxAttempts = 9, BaseDelay = 5, MaxDelay = 120 } })
		Batcher:Add(1001, 40, 0)
		local Flush = Batcher:TakeFor(1001) :: Flush
		local Now = 0
		local Waits: { number } = {}
		for _ = 1, 8 do
			Expect((Batcher:Requeue(Flush, 0, Now))).ToBe("Queued")
			Flush = Batcher:TakeDue(math.huge)[1]
			table.insert(Waits, Flush.NextAttemptAt - Now)
			Now = Flush.NextAttemptAt
		end
		Expect(Waits).ToEqual({ 5, 10, 20, 40, 80, 120, 120, 120 })
		Expect((Batcher:Requeue(Flush, 0, Now))).ToBe("GaveUp")
		Expect(Batcher:RetryCount()).ToBe(0)
		Expect({ Batcher:TakeDropped() }).ToEqual({ 1, 40 })
		Expect({ Batcher:TakeDropped() }).ToEqual({ 0, 0 })
	end)

	It("the default policy gives up after its sixth failed send", function()
		local Batcher = Make()
		Batcher:Add(1001, 5, 0)
		local Flush = Batcher:TakeFor(1001) :: Flush
		for _ = 1, 5 do
			Expect((Batcher:Requeue(Flush, 503, 0))).ToBe("Queued")
			Flush = Batcher:TakeDue(math.huge)[1]
		end
		Expect(Flush.Attempts).ToBe(5)
		Expect((Batcher:Requeue(Flush, 503, 0))).ToBe("GaveUp")
		Expect(EarnBatcher.RequeuePolicy.MaxAttempts).ToBe(6)
	end)

	It("the wait is jittered but never shorter than BaseDelay", function()
		local Half = Make({ Unit = 0.5 })
		Half:Add(1, 5, 0)
		Half:Requeue(Half:TakeFor(1) :: Flush, 503, 0)
		local Flush = Half:TakeDue(math.huge)[1]
		Half:Requeue(Flush, 503, 0)
		Half:Requeue(Half:TakeDue(math.huge)[1], 503, 0)
		-- The third try backs off up to 20 seconds and half of that is 10.
		Expect(Half:TakeDue(math.huge)[1].NextAttemptAt).ToBe(10)

		local Zero = Make({ Unit = 0 })
		Zero:Add(1, 5, 0)
		Zero:Requeue(Zero:TakeFor(1) :: Flush, 503, 50)
		Expect(Zero:TakeDue(math.huge)[1].NextAttemptAt).ToBe(55)
	end)

	It("honours the server's Retry-After on top of the backoff", function()
		local Batcher = Make()
		Batcher:Add(1001, 5, 0)
		Batcher:Requeue(Batcher:TakeFor(1001) :: Flush, 429, 0, 30)
		Expect(#Batcher:TakeDue(34.9)).ToBe(0)
		Expect(#Batcher:TakeDue(35)).ToBe(1)
	end)

	It("definite answers are never requeued", function()
		local Batcher = Make()
		for _, Status in { 400, 401, 403, 404, 409, 422, 200, 201 } do
			Batcher:Add(1001, 5, 0)
			local Flush = Batcher:TakeFor(1001) :: Flush
			local Outcome, Evicted = Batcher:Requeue(Flush, Status, 0)
			Expect(Outcome).ToBe("Final")
			Expect(Evicted).ToBeNil()
			Expect(Flush.Attempts).ToBe(0)
		end
		Expect(Batcher:RetryCount()).ToBe(0)
		Expect({ Batcher:TakeDropped() }).ToEqual({ 0, 0 })
	end)

	It("only temporary failures are worth sending again", function()
		for _, Status in { 0, -1, -2, -3, 408, 425, 429, 500, 502, 503, 504 } do
			Expect(EarnBatcher.ShouldRequeue(Status)).ToBe(true)
		end
		for _, Status in { 200, 201, 204, 400, 401, 403, 404, 409, 422, NaN } do
			Expect(EarnBatcher.ShouldRequeue(Status)).ToBe(false)
		end
	end)

	It("the retry list is bounded at 500 and gives back the batch it dropped", function()
		local Batcher = Make()
		local function Fresh(UserId: number): Flush
			Batcher:Add(UserId, 5, 0)
			return Batcher:TakeFor(UserId) :: Flush
		end
		local First = Fresh(1)
		Batcher:Requeue(First, 503, 0)
		for UserId = 2, 500 do
			Expect((select(2, Batcher:Requeue(Fresh(UserId), 503, 0)))).ToBeNil()
		end
		local Outcome, Evicted = Batcher:Requeue(Fresh(501), 503, 0)
		Expect(Outcome).ToBe("Queued")
		Expect((Evicted :: Flush).Key).ToBe(First.Key)
		Expect(Batcher:RetryCount()).ToBe(500)
		Expect({ Batcher:TakeDropped() }).ToEqual({ 1, 5 })
		local Due = Batcher:TakeDue(math.huge)
		Expect(#Due).ToBe(500)
		Expect(Due[1].UserId).ToBe(2)
		Expect(Due[500].UserId).ToBe(501)
	end)

	It("due retries come out in the order they were queued, and later ones wait", function()
		local Batcher = Make()
		for UserId = 1, 3 do
			Batcher:Add(UserId, 5, 0)
		end
		local A = Batcher:TakeFor(1) :: Flush
		local B = Batcher:TakeFor(2) :: Flush
		Batcher:Requeue(A, 503, 0, 20)
		Batcher:Requeue(B, 503, 0)
		Expect(Brief(Batcher:TakeDue(10))).ToEqual({ { 2, 5, B.Key } })
		Expect(Brief(Batcher:TakeDue(30))).ToEqual({ { 1, 5, A.Key }, { 3, 5, `{Tag}:3:1` } })
	end)
end)

return nil
