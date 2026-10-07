--!strict
local Harness = require("@Tests/Harness")
local Loader = require("@Shared/Util/Loader")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

-- Tiny stand ins for ModuleScripts and Folders, so the Loader can run outside Roblox.
local function FakeModule(Name: string, Value: any, Options: { [string]: any }?): any
	local Settings = Options or {}
	return {
		Name = Name,
		Value = Value,
		Throws = Settings.Throws == true,
		ClassName = Settings.ClassName or "ModuleScript",
		Attributes = Settings.Attributes or {},
		IsA = function(self: any, ClassName: string): boolean
			return self.ClassName == ClassName
		end,
		GetAttribute = function(self: any, Key: string): any
			return self.Attributes[Key]
		end,
	}
end

local function FakeFolder(Children: { any }): any
	return {
		GetChildren = function(): { any }
			return Children
		end,
	}
end

local function MakeHooks(Warnings: { string }): Loader.Hooks
	return {
		Require = function(Module: any): any
			if Module.Throws then
				error(`{Module.Name} exploded`)
			end
			return Module.Value
		end,
		Warn = function(Message: string)
			table.insert(Warnings, Message)
		end,
		Spawn = function(Callback: () -> ())
			Callback()
		end,
	}
end

local function Names(List: { Loader.Loaded }): { string }
	local Result = {}
	for _, Entry in List do
		table.insert(Result, Entry.Name)
	end
	return Result
end

Describe("Loader.LoadFolders", function()
	It("loads modules sorted by name across folders", function()
		local Hooks = MakeHooks({})
		local List = Loader.LoadFolders({
			FakeFolder({ FakeModule("Zed", {}), FakeModule("Alpha", {}) }),
			FakeFolder({ FakeModule("Mid", {}) }),
		}, Hooks)
		Expect(Names(List)).ToEqual({ "Alpha", "Mid", "Zed" })
	end)

	It("skips Disabled modules, -Template-, and things that are not ModuleScripts", function()
		local List = Loader.LoadFolders({
			FakeFolder({
				FakeModule("Off", {}, { Attributes = { Disabled = true } }),
				FakeModule("-Template-", {}),
				FakeModule("Folder", {}, { ClassName = "Folder" }),
				FakeModule("On", {}),
			}),
		}, MakeHooks({}))
		Expect(Names(List)).ToEqual({ "On" })
	end)

	It("skips class modules that have new or Get", function()
		local List = Loader.LoadFolders({
			FakeFolder({
				FakeModule("Orb", { new = function() end }),
				FakeModule("Registry", { Get = function() end }),
				FakeModule("Service", {}),
			}),
		}, MakeHooks({}))
		Expect(Names(List)).ToEqual({ "Service" })
	end)

	It("warns about a module that fails to load and keeps loading the rest", function()
		local Warnings = {}
		local List = Loader.LoadFolders({
			FakeFolder({ FakeModule("Broken", {}, { Throws = true }), FakeModule("Fine", {}) }),
		}, MakeHooks(Warnings))
		Expect(Names(List)).ToEqual({ "Fine" })
		Expect(#Warnings).ToBe(1)
		Expect(string.find(Warnings[1], "Broken", 1, true) ~= nil).ToBe(true)
	end)

	It("puts lower Priority first and breaks ties by name", function()
		local List = Loader.LoadFolders({
			FakeFolder({
				FakeModule("Bravo", {}),
				FakeModule("Late", { Priority = 200 }),
				FakeModule("Early", { Priority = 1 }),
				FakeModule("Alpha", {}),
			}),
		}, MakeHooks({}))
		Expect(Names(List)).ToEqual({ "Early", "Alpha", "Bravo", "Late" })
	end)
end)

Describe("Loader.InitAll and StartAll", function()
	It("calls Init in order with the module as self", function()
		local Calls = {}
		local function Service(Name: string): any
			local Module = {}
			function Module.Init(self: any)
				table.insert(Calls, Name)
				Expect(self).ToBe(Module)
			end
			return Module
		end
		local List = Loader.LoadFolders({
			FakeFolder({ FakeModule("B", Service("B")), FakeModule("A", Service("A")) }),
		}, MakeHooks({}))
		local Ready = Loader.InitAll(List, MakeHooks({}))
		Expect(Calls).ToEqual({ "A", "B" })
		Expect(#Ready).ToBe(2)
	end)

	It("a service whose Init throws is warned, left out, and the rest still Init and Start", function()
		local Warnings = {}
		local Started = {}
		local function Service(Name: string, Throws: boolean): any
			return {
				Init = function()
					if Throws then
						error("init broke")
					end
				end,
				Start = function()
					table.insert(Started, Name)
				end,
			}
		end
		local Hooks = MakeHooks(Warnings)
		local List = Loader.LoadFolders({
			FakeFolder({
				FakeModule("A", Service("A", false)),
				FakeModule("B", Service("B", true)),
				FakeModule("C", Service("C", false)),
			}),
		}, Hooks)
		local Ready = Loader.InitAll(List, Hooks)
		Loader.StartAll(Ready, Hooks)
		Expect(Names(Ready)).ToEqual({ "A", "C" })
		Expect(Started).ToEqual({ "A", "C" })
		Expect(string.find(Warnings[1], "B Init failed", 1, true) ~= nil).ToBe(true)
	end)

	It("a service whose Init yields is flagged and never Started", function()
		local Warnings = {}
		local Hooks = MakeHooks(Warnings)
		local List = Loader.LoadFolders({
			FakeFolder({ FakeModule("Waiter", {
				Init = function()
					coroutine.yield()
				end,
			}) }),
		}, Hooks)
		local Ready = Loader.InitAll(List, Hooks)
		Expect(#Ready).ToBe(0)
		Expect(string.find(Warnings[1], "Waiter Init yielded", 1, true) ~= nil).ToBe(true)
	end)

	It("a yielded Init thread is closed so nothing can resume it later", function()
		local FlagSet = false
		local Captured: thread? = nil
		local Hooks = MakeHooks({})
		local List = Loader.LoadFolders({
			FakeFolder({
				FakeModule("Sleeper", {
					Init = function()
						Captured = coroutine.running()
						coroutine.yield()
						FlagSet = true
					end,
				}),
			}),
		}, Hooks)
		Loader.InitAll(List, Hooks)
		local Thread = Captured :: thread
		Expect(coroutine.status(Thread)).ToBe("dead")
		-- Pretend the scheduler tries to wake it up anyway. It should stay asleep for good.
		pcall(coroutine.resume, Thread)
		Expect(FlagSet).ToBe(false)
	end)

	It("a well behaved module after a yielder still Inits, and only it is Ready", function()
		local Warnings = {}
		local GoodInitRan = false
		local Hooks = MakeHooks(Warnings)
		local List = Loader.LoadFolders({
			FakeFolder({
				FakeModule("AYielder", {
					Init = function()
						coroutine.yield()
					end,
				}),
				FakeModule("BGood", {
					Init = function()
						GoodInitRan = true
					end,
				}),
			}),
		}, Hooks)
		local Ready = Loader.InitAll(List, Hooks)
		Expect(GoodInitRan).ToBe(true)
		Expect(Names(Ready)).ToEqual({ "BGood" })
		Expect(#Warnings).ToBe(1)
	end)

	It("modules without Init still count as ready", function()
		local List = Loader.LoadFolders({ FakeFolder({ FakeModule("Plain", {}) }) }, MakeHooks({}))
		Expect(#Loader.InitAll(List, MakeHooks({}))).ToBe(1)
	end)

	It("a Start that throws is warned and does not stop the others", function()
		local Warnings = {}
		local Started = {}
		local Hooks = MakeHooks(Warnings)
		local List = Loader.LoadFolders({
			FakeFolder({
				FakeModule("A", {
					Start = function()
						error("start broke")
					end,
				}),
				FakeModule("B", {
					Start = function()
						table.insert(Started, "B")
					end,
				}),
			}),
		}, Hooks)
		Loader.StartAll(Loader.InitAll(List, Hooks), Hooks)
		Expect(Started).ToEqual({ "B" })
		Expect(string.find(Warnings[1], "A Start failed", 1, true) ~= nil).ToBe(true)
	end)
end)

return nil
