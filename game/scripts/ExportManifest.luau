--!strict
-- Writes contracts/framework-manifest.json from the game source, so tools and agents can see every
-- service, controller and packet without opening Studio.
-- Run it from the game folder with lune run scripts/ExportManifest
-- Give it a path to write somewhere else instead. CI does that to check the committed file is current.
local Fs = require("@lune/fs")
local Process = require("@lune/process")
local Packets = require("@Shared/Net/Packets")
local JsonEncode = require("./JsonEncode")
local ManifestBuilder = require("./ManifestBuilder")

local Sources = {
	{ Folder = "src/ServerStorage/Classes/Services", Kind = "service" },
	{ Folder = "src/ReplicatedStorage/Classes/Controllers", Kind = "controller" },
}

local Files: { ManifestBuilder.SourceFile } = {}
for _, Source in Sources do
	if not Fs.isDir(Source.Folder) then
		continue
	end
	for _, Name in Fs.readDir(Source.Folder) do
		if string.sub(Name, -5) == ".luau" then
			local Path = `{Source.Folder}/{Name}`
			table.insert(Files, { Path = `game/{Path}`, Kind = Source.Kind, Source = Fs.readFile(Path) })
		end
	end
end

local OutputPath = Process.args[1] or "../contracts/framework-manifest.json"
local Manifest = ManifestBuilder.Build(Files, Packets.List)
Fs.writeFile(OutputPath, JsonEncode.Encode(Manifest))
print(`wrote {OutputPath} with {#Manifest.modules} modules and {#Manifest.packets} packets`)
