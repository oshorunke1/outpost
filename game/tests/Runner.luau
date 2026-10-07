--!strict
-- Finds every spec file under tests, runs each one, and prints a pass or fail line per test.
-- Run it from the game folder with lune run tests/Runner
-- Add a word after it to only run specs whose path contains that word, like lune run tests/Runner Migrator
local Fs = require("@lune/fs")
local Process = require("@lune/process")
local Harness = require("./Harness")

local Suffix = ".spec.luau"
local Filter: string? = Process.args[1]

local function Collect(Folder: string, Found: { string })
	for _, Name in Fs.readDir(Folder) do
		local Path = `{Folder}/{Name}`
		if Fs.isDir(Path) then
			Collect(Path, Found)
		elseif string.sub(Name, -#Suffix) == Suffix then
			if Filter == nil or string.find(Path, Filter, 1, true) ~= nil then
				table.insert(Found, Path)
			end
		end
	end
end

local Specs: { string } = {}
Collect("tests", Specs)
table.sort(Specs)

local Passed = 0
local Failed = 0

for _, Path in Specs do
	-- tests/Net/RateLimiter.spec.luau becomes ./Net/RateLimiter.spec, which require understands
	local ModulePath = "./" .. string.sub(Path, #"tests/" + 1, -#".luau" - 1)
	local Loaded, LoadError = pcall(function()
		return require(ModulePath)
	end)
	if not Loaded then
		Failed += 1
		print(`FAIL  {Path} could not load\n      {LoadError}`)
	end
	for _, Result in Harness.TakeResults() do
		if Result.Passed then
			Passed += 1
			print(`PASS  {Result.Name}`)
		else
			Failed += 1
			print(`FAIL  {Result.Name}\n      {Result.Message}`)
		end
	end
end

print(`\n{Passed} passed, {Failed} failed, {#Specs} spec files`)
if Failed > 0 or #Specs == 0 then
	Process.exit(1)
end
Process.exit(0)
