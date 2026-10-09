--!strict
local Fs = require("@lune/fs")
local Serde = require("@lune/serde")
local Harness = require("@Tests/Harness")
local BackendConfig = require("@ServerConfigs/Backend")
local BackendClient = require("@Logic/Backend/BackendClient")

local Describe = Harness.Describe
local It = Harness.It
local Expect = Harness.Expect

-- Every file under a folder, so the spec can look for leaked config values.
local function Walk(Folder: string, Found: { string })
	for _, Name in Fs.readDir(Folder) do
		local Path = `{Folder}/{Name}`
		if Fs.isDir(Path) then
			Walk(Path, Found)
		else
			table.insert(Found, Path)
		end
	end
end

Describe("Configs/Backend", function()
	It(
		"ships turned off, so no server talks to a backend and Studio keeps the old Coins until someone opts in",
		function()
			Expect(BackendConfig.Enabled).ToBe(false)
			Expect(BackendConfig.StudioLedger).ToBe(false)
		end
	)

	It("a full burst plus a minute of refill stays under Roblox's 500 requests a minute", function()
		Expect(BackendConfig.HttpBurst + BackendConfig.HttpBudgetPerMinute < 500).ToBe(true)
		Expect(BackendConfig.HttpBurst >= 1).ToBe(true)
		Expect(BackendConfig.HttpBudgetPerMinute > 0).ToBe(true)
	end)

	It("only ever talks https and names its secret", function()
		Expect(string.sub(BackendConfig.BaseUrl, 1, 8)).ToBe("https://")
		Expect(string.sub(BackendConfig.BaseUrl, -1) ~= "/").ToBe(true)
		Expect(#BackendConfig.SecretName > 0).ToBe(true)
	end)

	It("one slow request still fits inside the time a token trade may take before it counts as stuck", function()
		local Seconds = BackendConfig.RequestTimeoutSeconds
		Expect(Seconds > 0).ToBe(true)
		Expect(Seconds + BackendClient.ExchangeDeadlineSeconds <= BackendClient.ExchangeStaleSeconds).ToBe(true)
	end)

	It("is frozen, so nothing can flip it at runtime", function()
		Expect(table.isfrozen(BackendConfig :: any)).ToBe(true)
	end)

	It("lives in ServerStorage, which Roblox never sends to players", function()
		local Project = Serde.decode("json", Fs.readFile("default.project.json"))
		Expect(Project.tree.ServerStorage.Configs["$path"]).ToBe("src/ServerStorage/Configs")
		Expect(Fs.isFile("src/ServerStorage/Configs/Backend.luau")).ToBe(true)
		Expect(Fs.isFile("src/ReplicatedStorage/Shared/Configs/Backend.luau")).ToBe(false)
	end)

	It("no file that players can see mentions the backend address or the secret name", function()
		local Files: { string } = {}
		Walk("src/ReplicatedStorage", Files)
		Walk("src/StarterPlayer", Files)
		Expect(#Files > 0).ToBe(true)
		for _, Path in Files do
			local Source = Fs.readFile(Path)
			if
				string.find(Source, BackendConfig.SecretName, 1, true)
				or string.find(Source, BackendConfig.BaseUrl, 1, true)
			then
				error(`{Path} mentions the backend config, which must stay on the server`)
			end
		end
	end)
end)

return nil
