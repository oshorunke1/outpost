--!strict
-- Loader requires every ModuleScript sitting directly inside the folders you give it.
-- It skips modules with a truthy Disabled attribute, modules named -Template-, and class modules
-- that have a new or Get function, since other code makes those and they are not booted.
-- A module that fails to load gets a warning and the rest keep going.
-- Hooks let tests swap in fake require, warn and spawn functions. Real boot scripts pass nothing.

export type Hooks = {
	Require: ((Module: any) -> any)?,
	Warn: ((Message: string) -> ())?,
	Spawn: ((Callback: () -> ()) -> ())?,
}
export type Loaded = { Name: string, Module: any, Priority: number }

local Loader = {}

Loader.DefaultPriority = 100

local function DefaultWarn(Message: string)
	warn(Message)
end

local function DefaultSpawn(Callback: () -> ())
	task.spawn(Callback)
end

-- Hands back the hook the caller gave us for this key, or the default when there isn't one.
local function Pick(Hooks: Hooks?, Key: string, Default: any): any
	if Hooks then
		local Custom = (Hooks :: any)[Key]
		if Custom ~= nil then
			return Custom
		end
	end
	return Default
end

local function IsClass(Module: any): boolean
	return type(Module) == "table" and (type(Module.new) == "function" or type(Module.Get) == "function")
end

local function ByPriorityThenName(Left: Loaded, Right: Loaded): boolean
	if Left.Priority ~= Right.Priority then
		return Left.Priority < Right.Priority
	end
	return Left.Name < Right.Name
end

function Loader.LoadFolders(Folders: { Instance }, Hooks: Hooks?): { Loaded }
	local Require = Pick(Hooks, "Require", require) :: (any) -> any
	local Warn = Pick(Hooks, "Warn", DefaultWarn) :: (string) -> ()
	local List: { Loaded } = {}
	for _, Folder in Folders do
		for _, Child in Folder:GetChildren() do
			if not Child:IsA("ModuleScript") then
				continue
			end
			if Child:GetAttribute("Disabled") or Child.Name == "-Template-" then
				continue
			end
			local Ok, Result = pcall(Require, Child)
			if not Ok then
				Warn(`[Loader] {Child.Name} failed to load, {Result}`)
				continue
			end
			if IsClass(Result) then
				continue
			end
			local Priority = if type(Result) == "table" and type(Result.Priority) == "number"
				then Result.Priority
				else Loader.DefaultPriority
			table.insert(List, { Name = Child.Name, Module = Result, Priority = Priority })
		end
	end
	table.sort(List, ByPriorityThenName)
	return List
end

-- Runs Init on every module, one after another. Init has to finish straight away, so each one runs
-- in its own coroutine and we check it really finished. One that errors or yields is left out of
-- the returned list, so it never gets Started, and everything else carries on. A yielded thread
-- also gets closed, so the rest of that Init can never run later.
function Loader.InitAll(List: { Loaded }, Hooks: Hooks?): { Loaded }
	local Warn = Pick(Hooks, "Warn", DefaultWarn) :: (string) -> ()
	local Ready: { Loaded } = {}
	for _, Entry in List do
		local Init = if type(Entry.Module) == "table" then Entry.Module.Init else nil
		if type(Init) ~= "function" then
			table.insert(Ready, Entry)
			continue
		end
		local Thread = coroutine.create(Init)
		local Ok, Err = coroutine.resume(Thread, Entry.Module)
		if not Ok then
			Warn(`[Loader] {Entry.Name} Init failed, {Err}`)
		elseif coroutine.status(Thread) ~= "dead" then
			Warn(`[Loader] {Entry.Name} Init yielded. Init must never wait, so move that work into Start`)
			-- Close the paused thread so the scheduler can never wake it up and finish Init later.
			coroutine.close(Thread)
		else
			table.insert(Ready, Entry)
		end
	end
	return Ready
end

-- Runs Start on every module in its own thread, so one slow Start can never hold up the rest.
function Loader.StartAll(List: { Loaded }, Hooks: Hooks?)
	local Warn = Pick(Hooks, "Warn", DefaultWarn) :: (string) -> ()
	local Spawn = Pick(Hooks, "Spawn", DefaultSpawn) :: (() -> ()) -> ()
	for _, Entry in List do
		local Start = if type(Entry.Module) == "table" then Entry.Module.Start else nil
		if type(Start) == "function" then
			Spawn(function()
				local Ok, Err = pcall(Start, Entry.Module)
				if not Ok then
					Warn(`[Loader] {Entry.Name} Start failed, {Err}`)
				end
			end)
		end
	end
end

return Loader
