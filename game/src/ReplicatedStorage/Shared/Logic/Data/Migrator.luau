--!strict
-- Upgrades an old save to the current schema one step at a time.
-- It always works on a deep copy, so if any step throws, the original save is exactly as it was
-- and the caller can refuse to load the player instead of saving half migrated data.

export type Outcome = {
	Ok: boolean,
	Data: { [string]: any }?,
	Error: string?,
	FromVersion: number,
	ToVersion: number,
}

type Migration = (Data: { [string]: any }) -> ()

local Migrator = {}

local function DeepCopy(Value: any): any
	if type(Value) ~= "table" then
		return Value
	end
	local Copy = {}
	for Key, Inner in Value do
		Copy[DeepCopy(Key)] = DeepCopy(Inner)
	end
	return Copy
end

local function Fail(Message: string, From: number, Target: number): Outcome
	return { Ok = false, Error = Message, FromVersion = From, ToVersion = Target }
end

function Migrator.Run(Data: { [string]: any }, MigrationList: { Migration }): Outcome
	local Target = #MigrationList + 1
	local Raw = Data.SchemaVersion
	local From: number = if Raw == nil then 1 else Raw
	if type(Raw) ~= "nil" and (type(Raw) ~= "number" or Raw % 1 ~= 0 or Raw < 1) then
		return Fail(`SchemaVersion {tostring(Raw)} is not a whole number of at least 1`, 0, Target)
	end
	if From > Target then
		return Fail(`this save is from a newer version ({From}) than this server knows ({Target})`, From, Target)
	end

	local Copy = DeepCopy(Data)
	for Version = From, Target - 1 do
		local Ok, Err = pcall(MigrationList[Version] :: (any) -> any, Copy)
		if not Ok then
			return Fail(`migration {Version} to {Version + 1} failed, {Err}`, From, Target)
		end
		Copy.SchemaVersion = Version + 1
	end
	Copy.SchemaVersion = Target
	return { Ok = true, Data = Copy, FromVersion = From, ToVersion = Target }
end

return Migrator
