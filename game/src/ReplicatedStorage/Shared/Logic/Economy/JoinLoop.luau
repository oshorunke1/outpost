--!strict
-- JoinLoop runs EconomyCore.JoinStep for a player, waiting with backoff between tries, until the
-- join and the steps after it are settled.
-- Every visit gets its own number from BeginVisit. A loop belongs to the visit it started in and
-- stops at its next pass once a newer visit begins. So a loop from before a rejoin, say one still
-- joining for Coins held after the player left, can never block the new visit's loop or end its
-- join and reconcile. Only one loop runs per visit, so a second Run while one is going says Busy.
-- A player who left is only joined while Coins are held for them, and those are given up after
-- LeftJoinSeconds.
-- Nothing here touches game. The core, the clock, the wait and the backoff are passed in.

export type Deps = {
	Core: any, -- an EconomyCore
	IsHere: (UserId: number) -> boolean,
	-- Tells the player's screen about the new state after each pass.
	Push: (UserId: number) -> (),
	Wait: (Seconds: number) -> (),
	Now: () -> number,
	-- The wait before try number Attempt.
	DelayFor: (Attempt: number) -> number,
	LeftJoinSeconds: number,
	Warn: (Message: string) -> (),
}

export type Outcome = "Done" | "Busy" | "Superseded" | "GaveUp" | "Failed"

type Fields = {
	Deps: Deps,
	Visits: { [number]: number },
	Running: { [number]: number },
}

local JoinLoop = {}
JoinLoop.__index = JoinLoop

export type JoinLoop = typeof(setmetatable({} :: Fields, JoinLoop))

-- The shortest wait between tries, so a backoff of zero can never spin.
local MinWaitSeconds = 1

function JoinLoop.new(Deps: Deps): JoinLoop
	local Object: Fields = { Deps = Deps, Visits = {}, Running = {} }
	return setmetatable(Object, JoinLoop)
end

-- A new visit starts for the player. Any loop from an older visit stops at its next pass.
function JoinLoop.BeginVisit(self: JoinLoop, UserId: number)
	self.Visits[UserId] = (self.Visits[UserId] or 0) + 1
	self.Deps.Core:BeginVisit(UserId)
end

local function Passes(self: JoinLoop, UserId: number, Visit: number): Outcome
	local Deps = self.Deps
	local Attempt = 0
	local LeftAt: number? = nil
	while true do
		if self.Visits[UserId] ~= Visit then
			return "Superseded"
		end
		local Here = Deps.IsHere(UserId)
		local Step = Deps.Core:JoinStep(UserId, Here)
		if self.Visits[UserId] ~= Visit then
			return "Superseded"
		end
		Deps.Push(UserId)
		if Step == "Done" then
			return "Done"
		end
		if not Here then
			local Since = LeftAt or Deps.Now()
			LeftAt = Since
			if Deps.Now() - Since > Deps.LeftJoinSeconds then
				Deps.Core:DropHeld(UserId)
				return "GaveUp"
			end
		end
		Attempt += 1
		Deps.Wait(math.max(MinWaitSeconds, Deps.DelayFor(Attempt)))
	end
end

-- Runs the join steps for the player's current visit until they settle. Yields while it waits.
function JoinLoop.Run(self: JoinLoop, UserId: number): Outcome
	local Visit = self.Visits[UserId] or 0
	self.Visits[UserId] = Visit
	if self.Running[UserId] == Visit then
		return "Busy"
	end
	self.Running[UserId] = Visit
	local Ran, Result = pcall(Passes, self, UserId, Visit)
	-- A newer visit may have started its own loop by now, so only clear our own mark.
	if self.Running[UserId] == Visit then
		self.Running[UserId] = nil
	end
	if not Ran then
		self.Deps.Warn(`the join loop for {UserId} threw, {Result}`)
		return "Failed"
	end
	return Result :: Outcome
end

return JoinLoop
