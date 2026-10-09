--!strict
-- The per player join loop. A loop belongs to one visit, so a loop left over from before a rejoin
-- can never block or end the new visit's join and reconcile.
local Harness = require("@Tests/Harness")
local EconomyRig = require("@Tests/Economy/EconomyRig")
local JoinLoop = require("@Logic/Economy/JoinLoop")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

-- A rig whose next join can be parked mid flight, a loop over its core, and who is in the server.
-- The parked join yields the coroutine that sent it, so the spec can act while it is on the wire.
local function NewRig(Options: { FailJoins: boolean? }?)
	local Given = Options or {}
	local Gate = { HoldJoin = false, HoldWait = false }
	local Rig = EconomyRig.new({
		Intercept = function(Request: any): any?
			if string.match(Request.Url, "/sessions$") == nil then
				return nil
			end
			if Gate.HoldJoin then
				Gate.HoldJoin = false
				coroutine.yield()
			end
			if Given.FailJoins then
				return { Ok = false, Status = 503, Body = nil, Headers = {} }
			end
			return nil
		end,
	})
	Rig.Gate = Gate
	Rig.Here = {} :: { [number]: boolean }
	Rig.Waits = 0
	Rig.Loops = JoinLoop.new({
		Core = Rig.Core,
		IsHere = function(UserId: number)
			return Rig.Here[UserId] == true
		end,
		Push = function(_UserId: number) end,
		Wait = function(Seconds: number)
			Rig.Waits += 1
			assert(Rig.Waits < 1000, "the loop never settled")
			Rig.Clock.Now += Seconds
			if Gate.HoldWait then
				Gate.HoldWait = false
				coroutine.yield()
			end
		end,
		Now = function()
			return Rig.Clock.Now
		end,
		DelayFor = function(_Attempt: number)
			return 2
		end,
		LeftJoinSeconds = 600,
		Warn = function(Message: string)
			table.insert(Rig.Warnings, Message)
		end,
	})
	return Rig
end

-- Runs a loop on its own coroutine. It stops at the first parked join or wait.
local function StartLoop(Rig: any, UserId: number): thread
	local Thread = coroutine.create(function()
		return Rig.Loops:Run(UserId)
	end)
	local Resumed, Err = coroutine.resume(Thread)
	assert(Resumed, Err)
	return Thread
end

local function Finish(Thread: thread): any
	local Resumed, Result = coroutine.resume(Thread)
	assert(Resumed, Result)
	assert(coroutine.status(Thread) == "dead", "the loop should have finished")
	return Result
end

Describe("JoinLoop visits", function()
	It("a rejoin while the old join is in flight still joins, reconciles and lets the player buy", function()
		local Rig = NewRig()
		Rig.Player(1001, nil, false)
		-- First visit. The join has not landed, so a full batch of Coins is held.
		Rig.Loops:BeginVisit(1001)
		Rig.Core:Earn(1001, 200)
		Expect(Rig.Core:HeldCoins(1001)).ToBe(200)
		-- The player leaves. The loop keeps going for the held Coins and its join is on the wire.
		Rig.Core:Leave(1001)
		Rig.Gate.HoldJoin = true
		local Old = StartLoop(Rig, 1001)
		Expect(coroutine.status(Old)).ToBe("suspended")
		-- The player comes back to the same server before that join answers.
		Rig.Here[1001] = true
		Rig.Loops:BeginVisit(1001)
		Expect(Rig.Loops:Run(1001)).ToBe("Done")
		-- The old join answers late. Its loop sees the newer visit and stops.
		Expect(Finish(Old)).ToBe("Superseded")
		local Decision = Rig.Core:Purchase(1001, "RedHat")
		Expect(Decision.Outcome).ToBe("Granted")
		Expect(Rig.Wallet(1001)).ToBe(175)
		Expect(#Rig.Sent("earn")).ToBe(1)
	end)

	It("an old loop waiting between tries stops at its next pass without sending anything", function()
		local Rig = NewRig({ FailJoins = true })
		Rig.Player(1001, nil, false)
		Rig.Here[1001] = true
		Rig.Loops:BeginVisit(1001)
		Rig.Gate.HoldWait = true
		local Old = StartLoop(Rig, 1001)
		Expect(coroutine.status(Old)).ToBe("suspended")
		local JoinsBefore = #Rig.Sent("join")
		Rig.Loops:BeginVisit(1001)
		Expect(Finish(Old)).ToBe("Superseded")
		Expect(#Rig.Sent("join")).ToBe(JoinsBefore)
	end)

	It("an old loop that stops never clears the running mark of the new visit's loop", function()
		local Rig = NewRig({ FailJoins = true })
		Rig.Player(1001, nil, false)
		Rig.Here[1001] = true
		Rig.Loops:BeginVisit(1001)
		Rig.Gate.HoldWait = true
		local Old = StartLoop(Rig, 1001)
		-- The player rejoins and the new visit's loop parks in its own wait.
		Rig.Loops:BeginVisit(1001)
		Rig.Gate.HoldWait = true
		local New = StartLoop(Rig, 1001)
		Expect(coroutine.status(New)).ToBe("suspended")
		Expect(Finish(Old)).ToBe("Superseded")
		-- The new loop is still going, so another Run for this visit must still say Busy.
		Expect(Rig.Loops:Run(1001)).ToBe("Busy")
	end)

	It("only one loop runs per visit", function()
		local Rig = NewRig()
		Rig.Player(1001, nil, false)
		Rig.Here[1001] = true
		Rig.Loops:BeginVisit(1001)
		Rig.Gate.HoldJoin = true
		local First = StartLoop(Rig, 1001)
		Expect(Rig.Loops:Run(1001)).ToBe("Busy")
		Expect(Finish(First)).ToBe("Done")
		-- Once it finished, the same visit can run the steps again, as RunJoinSteps does.
		Expect(Rig.Loops:Run(1001)).ToBe("Done")
	end)

	It("a player who left gives up the held Coins once the join never lands for too long", function()
		local Rig = NewRig({ FailJoins = true })
		Rig.Player(1001, nil, false)
		Rig.Loops:BeginVisit(1001)
		Rig.Core:Earn(1001, 200)
		Rig.Core:Leave(1001)
		Expect(Rig.Loops:Run(1001)).ToBe("GaveUp")
		Expect(Rig.Core:HeldCoins(1001)).ToBe(0)
		Expect(Rig.Clock.Now > 600).ToBe(true)
	end)

	It("a step that throws is warned and frees the visit for the next run", function()
		local Warnings = {}
		local Calls = 0
		local Loops = JoinLoop.new({
			Core = {
				BeginVisit = function() end,
				JoinStep = function()
					Calls += 1
					if Calls == 1 then
						error("boom")
					end
					return "Done"
				end,
			},
			IsHere = function()
				return true
			end,
			Push = function() end,
			Wait = function() end,
			Now = function()
				return 0
			end,
			DelayFor = function()
				return 1
			end,
			LeftJoinSeconds = 600,
			Warn = function(Message: string)
				table.insert(Warnings, Message)
			end,
		})
		Loops:BeginVisit(7)
		Expect(Loops:Run(7)).ToBe("Failed")
		Expect(#Warnings).ToBe(1)
		Expect(Loops:Run(7)).ToBe("Done")
	end)
end)

return nil
