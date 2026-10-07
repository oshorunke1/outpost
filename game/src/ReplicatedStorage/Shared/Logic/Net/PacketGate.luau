--!strict
-- PacketGate decides whether a packet from a player gets through. It knows nothing about Roblox.
-- NetGuard does the Roblox side and asks the gate about every packet that arrives.
-- The checks run in this order. Unknown packet, wrong direction, nobody listening, too many
-- arguments, rate limit, and last the payload shape. The rate limit runs before the payload
-- check on purpose, so spam with broken payloads still burns tokens.
-- Everything a client controls (the name, the argument count, the payload) is treated as hostile.
-- Admit never throws on it. Anything odd just gets a refusing verdict.

export type Reason =
	"Ok"
	| "UnknownPacket"
	| "WrongDirection"
	| "NoHandler"
	| "TooManyArguments"
	| "Throttled"
	| "BadPayload"
export type Verdict = { Accepted: boolean, Reason: Reason, ShouldLog: boolean }
export type Entry = { Direction: string, Check: ((any) -> boolean)?, Limiter: any }
export type Handler = (Player: any, Payload: any) -> ()

type Fields = {
	Entries: { [string]: Entry },
	Handlers: { [string]: Handler },
	Sealed: boolean,
	LogEverySeconds: number,
	LastLogged: { [number]: { [string]: number } },
}

-- Unknown names all share this one log slot, so a client sending endless made up names cannot grow memory.
local UnknownLogKey = "?"

local PacketGate = {}
PacketGate.__index = PacketGate

export type PacketGate = typeof(setmetatable({} :: Fields, PacketGate))

function PacketGate.new(Entries: { [string]: Entry }, LogEverySeconds: number): PacketGate
	for Name, Entry in Entries do
		if Entry.Direction == "ClientToServer" and (Entry.Check == nil or Entry.Limiter == nil) then
			error(`packet {Name} comes from clients, so it needs a Check and a Limiter`, 2)
		end
	end
	local Object: Fields = {
		Entries = Entries,
		Handlers = {},
		Sealed = false,
		LogEverySeconds = LogEverySeconds,
		LastLogged = {},
	}
	return setmetatable(Object, PacketGate)
end

function PacketGate.Listen(self: PacketGate, Name: string, Handler: Handler)
	if self.Sealed then
		error(`NetGuard is sealed, so {Name} cannot be listened to now. Call Listen from Init`, 2)
	end
	local Entry = self.Entries[Name]
	if Entry == nil then
		error(`{Name} is not in Packets`, 2)
	end
	if Entry.Direction ~= "ClientToServer" then
		error(`{Name} is not a client to server packet`, 2)
	end
	if self.Handlers[Name] ~= nil then
		error(`{Name} already has a listener`, 2)
	end
	self.Handlers[Name] = Handler
end

function PacketGate.Seal(self: PacketGate)
	if self.Sealed then
		error("NetGuard is already sealed", 2)
	end
	self.Sealed = true
end

function PacketGate.IsSealed(self: PacketGate): boolean
	return self.Sealed
end

function PacketGate.HandlerFor(self: PacketGate, Name: string): Handler?
	return self.Handlers[Name]
end

local function IsFiniteNumber(Value: any): boolean
	return type(Value) == "number" and Value == Value and Value ~= math.huge and Value ~= -math.huge
end

-- Decides if a rejection should be logged, at most once per player per packet every LogEverySeconds.
local function ShouldLog(self: PacketGate, PlayerKey: number, LogKey: string, Now: number): boolean
	local PerPlayer = self.LastLogged[PlayerKey]
	if PerPlayer == nil then
		PerPlayer = {}
		self.LastLogged[PlayerKey] = PerPlayer
	end
	local Last = PerPlayer[LogKey]
	if Last ~= nil and Now - Last < self.LogEverySeconds then
		return false
	end
	PerPlayer[LogKey] = Now
	return true
end

local function Reject(self: PacketGate, PlayerKey: number, LogKey: string, Now: number, Reason: Reason): Verdict
	return { Accepted = false, Reason = Reason, ShouldLog = ShouldLog(self, PlayerKey, LogKey, Now) }
end

function PacketGate.Admit(
	self: PacketGate,
	PlayerKey: number,
	Name: string,
	ArgCount: number,
	Payload: any,
	Now: number
): Verdict
	-- The player key and the clock come from the server, but a bad one must still fail closed.
	if not IsFiniteNumber(PlayerKey) or not IsFiniteNumber(Now) then
		return { Accepted = false, Reason = "Throttled", ShouldLog = false }
	end
	-- The name comes from the client, so it can be anything at all.
	local Entry = if type(Name) == "string" then self.Entries[Name] else nil
	if Entry == nil then
		return Reject(self, PlayerKey, UnknownLogKey, Now, "UnknownPacket")
	end
	if Entry.Direction ~= "ClientToServer" then
		return Reject(self, PlayerKey, Name, Now, "WrongDirection")
	end
	if self.Handlers[Name] == nil then
		return Reject(self, PlayerKey, Name, Now, "NoHandler")
	end
	-- Anything that is not a plain count of zero or one is refused, including nil, NaN and strings.
	if type(ArgCount) ~= "number" or not (ArgCount <= 1) then
		return Reject(self, PlayerKey, Name, Now, "TooManyArguments")
	end
	if not Entry.Limiter:Allow(PlayerKey, Now) then
		return Reject(self, PlayerKey, Name, Now, "Throttled")
	end
	local Check = Entry.Check
	if Check == nil then
		return Reject(self, PlayerKey, Name, Now, "BadPayload")
	end
	-- A Check that throws counts as a failed check.
	local Ran, Passed = pcall(Check, Payload)
	if not Ran or Passed ~= true then
		return Reject(self, PlayerKey, Name, Now, "BadPayload")
	end
	return { Accepted = true, Reason = "Ok", ShouldLog = false }
end

-- Clears everything the gate remembers about a player. NetGuard calls this when they leave.
function PacketGate.Forget(self: PacketGate, PlayerKey: number)
	for _, Entry in self.Entries do
		if Entry.Limiter ~= nil then
			Entry.Limiter:Forget(PlayerKey)
		end
	end
	self.LastLogged[PlayerKey] = nil
end

return PacketGate
