--!strict
-- Turns the game's source files and the packet list into the framework manifest table.
-- Everything is sorted and line endings are ignored, so Windows and Linux build the same manifest.
-- The keys are camelCase on purpose, since TypeScript reads this file later.
local JsonEncode = require("./JsonEncode")
local Validate = require("@Logic/Net/Validate")

export type SourceFile = { Path: string, Kind: string, Source: string }

local ManifestBuilder = {}

function ManifestBuilder.CountLines(Source: string): number
	local Text = string.gsub(Source, "\r\n", "\n")
	if Text == "" then
		return 0
	end
	local _, Newlines = string.gsub(Text, "\n", "\n")
	if string.sub(Text, -1) == "\n" then
		return Newlines
	end
	return Newlines + 1
end

local function HasMethod(Source: string, Method: string): boolean
	return string.find(Source, "function%s+[%w_]+[:.]" .. Method .. "%s*%(") ~= nil
end

local function ListenedPackets(Source: string): { string }
	local Seen: { [string]: boolean } = {}
	local Names: { string } = {}
	for Name in string.gmatch(Source, 'NetGuard%.Listen%(%s*"([^"]+)"') do
		if not Seen[Name] then
			Seen[Name] = true
			table.insert(Names, Name)
		end
	end
	table.sort(Names)
	return Names
end

function ManifestBuilder.Build(Files: { SourceFile }, PacketList: { any }): { [string]: any }
	local Modules = {}
	for _, File in Files do
		local Source = string.gsub(File.Source, "\r\n", "\n")
		table.insert(Modules, {
			name = string.match(File.Path, "([^/]+)%.luau$") or File.Path,
			kind = File.Kind,
			path = File.Path,
			lineCount = ManifestBuilder.CountLines(Source),
			hasInit = HasMethod(Source, "Init"),
			hasStart = HasMethod(Source, "Start"),
			listens = ListenedPackets(Source),
		})
	end
	table.sort(Modules, function(Left, Right)
		if Left.name ~= Right.name then
			return Left.name < Right.name
		end
		return Left.path < Right.path
	end)

	local PacketsOut = {}
	for _, Def in PacketList do
		local Limit = Def.RateLimit
		table.insert(PacketsOut, {
			name = Def.Name,
			direction = Def.Direction,
			payload = Validate.Describe(Def.Payload),
			rateLimit = if Limit
				then { capacity = Limit.Capacity, refillPerSecond = Limit.RefillPerSecond }
				else JsonEncode.Null,
		})
	end
	table.sort(PacketsOut, function(Left, Right)
		return Left.name < Right.name
	end)

	return { manifestVersion = 1, modules = Modules, packets = PacketsOut }
end

return ManifestBuilder
