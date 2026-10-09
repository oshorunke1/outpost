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

-- True when the source gives the module a function with this name, in any of the usual shapes.
local function Defines(Source: string, Name: string): boolean
	local Patterns = {
		"function%s+[%w_]+[:.]" .. Name .. "%s*%(",
		"[%w_]+%." .. Name .. "%s*=",
		"%[%s*[\"']" .. Name .. "[\"']%s*%]%s*=",
	}
	for _, Pattern in Patterns do
		if string.find(Source, Pattern) ~= nil then
			return true
		end
	end
	return false
end

Describe("Loader guard", function()
	It("spots every way of naming a class function", function()
		Expect(Defines("function FlagService:Get(Key)", "Get")).ToBe(true)
		Expect(Defines("function FlagService.Get(Key)", "Get")).ToBe(true)
		Expect(Defines("FlagService.Get = function() end", "Get")).ToBe(true)
		Expect(Defines('FlagService["Get"] = Read', "Get")).ToBe(true)
		Expect(Defines("function Thing.new()", "new")).ToBe(true)
		Expect(Defines("function FlagService:GetAll()", "Get")).ToBe(false)
		Expect(Defines("local Value = Store:Get(Key)", "Get")).ToBe(false)
		Expect(Defines("function FlagService:Value(Key)", "Get")).ToBe(false)
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
