--!strict
-- The Loader skips any module with a new or Get function, because it takes those for classes.
-- A service or controller that grew a Get would quietly never boot, so this reads every module
-- the Loader has to start and fails when one of them has either name.
local Fs = require("@lune/fs")
local Harness = require("@Tests/Harness")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

local BootedFolders = {
	"src/ServerStorage/Classes/Services",
	"src/ReplicatedStorage/Classes/Controllers",
}

-- The names that make the Loader skip a module, see Loader.IsClass.
local ClassNames = { "new", "Get" }

-- The name of the table the module hands back, from its last return line.
local function ModuleName(Source: string): string?
	local Found: string? = nil
	for Name in string.gmatch(Source, "\nreturn%s+([%a_][%w_]*)") do
		Found = Name
	end
	return Found
end

-- True when the module's own table gets a function with this name, in any of the usual shapes.
-- Only the table the module returns counts, so a helper table may have its own new or Get.
-- An equals sign followed by another one is a comparison, never a definition.
local function Defines(Source: string, Name: string): boolean
	local Owner = ModuleName("\n" .. Source)
	if Owner == nil then
		return false
	end
	local Patterns = {
		"function%s+" .. Owner .. "[:.]" .. Name .. "%s*%(",
		"%f[%w_]" .. Owner .. "%." .. Name .. "%s*=[^=]",
		"%f[%w_]" .. Owner .. "%[%s*[\"']" .. Name .. "[\"']%s*%]%s*=[^=]",
	}
	for _, Pattern in Patterns do
		if string.find(Source, Pattern) ~= nil then
			return true
		end
	end
	-- The module's table constructor. Nested tables are cut out first, so only its own keys are left.
	local Body = string.match(Source, "%f[%w_]" .. Owner .. "%s*=%s*(%b{})")
	if Body ~= nil then
		local Keys = string.gsub(string.sub(Body, 2, -2), "%b{}", "")
		local Padded = `,{Keys}`
		if string.find(Padded, "[,;]%s*" .. Name .. "%s*=[^=]") ~= nil then
			return true
		end
	end
	return false
end

Describe("Loader guard", function()
	-- Source for a module called FlagService, which hands back FlagService like every booted module.
	local function Module(Body: string): string
		return `local FlagService = \{}\n{Body}\nreturn FlagService\n`
	end

	It("spots every way of naming a class function", function()
		Expect(Defines(Module("function FlagService:Get(Key)"), "Get")).ToBe(true)
		Expect(Defines(Module("function FlagService.Get(Key)"), "Get")).ToBe(true)
		Expect(Defines(Module("FlagService.Get = function() end"), "Get")).ToBe(true)
		Expect(Defines(Module("FlagService.Get=Read"), "Get")).ToBe(true)
		Expect(Defines(Module('FlagService["Get"] = Read'), "Get")).ToBe(true)
		Expect(Defines(Module("function FlagService.new()"), "new")).ToBe(true)
		Expect(Defines(Module("function FlagService:GetAll()"), "Get")).ToBe(false)
		Expect(Defines(Module("local Value = Store:Get(Key)"), "Get")).ToBe(false)
		Expect(Defines(Module("function FlagService:Value(Key)"), "Get")).ToBe(false)
	end)

	It("spots a class function inside the module's own table constructor", function()
		Expect(Defines("local FlagService = { Get = Read }\nreturn FlagService", "Get")).ToBe(true)
		Expect(Defines("local FlagService = {\n\tPriority = 15,\n\tnew = Make,\n}\nreturn FlagService", "new")).ToBe(
			true
		)
		Expect(Defines("local FlagService = {Priority=15;Get=Read}\nreturn FlagService", "Get")).ToBe(true)
	end)

	It("is not fooled by a comparison, a helper table or a nested table", function()
		Expect(Defines(Module("if FlagService.Get == nil then end"), "Get")).ToBe(false)
		Expect(Defines(Module("local Ready = FlagService.new==nil"), "new")).ToBe(false)
		Expect(Defines(Module("local Helpers = {}\nfunction Helpers.Get() end"), "Get")).ToBe(false)
		Expect(Defines(Module("local Helpers = {}\nHelpers.new = Make"), "new")).ToBe(false)
		Expect(Defines(Module("local Cache = { Get = Read, new = Make }"), "Get")).ToBe(false)
		Expect(Defines("local FlagService = { Store = { Get = Read } }\nreturn FlagService", "Get")).ToBe(false)
		Expect(Defines("local FlagService = { Ready = Get == nil }\nreturn FlagService", "Get")).ToBe(false)
	end)

	It("no service or controller has a new or Get function", function()
		local Checked = 0
		local Offenders: { string } = {}
		for _, Folder in BootedFolders do
			for _, Name in Fs.readDir(Folder) do
				if string.sub(Name, -5) ~= ".luau" then
					continue
				end
				Checked += 1
				local Source = Fs.readFile(`{Folder}/{Name}`)
				-- Without a return line the guard can't tell which table is the module, so that fails too.
				if ModuleName("\n" .. Source) == nil then
					table.insert(Offenders, `{Name} has no return line`)
				end
				for _, ClassName in ClassNames do
					if Defines(Source, ClassName) then
						table.insert(Offenders, `{Name} has {ClassName}`)
					end
				end
			end
		end
		Expect(Checked > 0).ToBe(true)
		Expect(Offenders).ToEqual({})
	end)
end)

return nil
