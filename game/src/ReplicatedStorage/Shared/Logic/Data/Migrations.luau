--!strict
-- Every save upgrade lives here, in order. Migrations[1] turns a version 1 save into version 2,
-- Migrations[2] turns version 2 into version 3, and so on.
-- Template.SchemaVersion must always be one more than the number of migrations, and a test checks that.
-- Each migration gets a copy of the save and changes it in place.

export type Migration = (Data: { [string]: any }) -> ()

-- The biggest whole number a save can hold exactly.
local MaxSafeInteger = 9007199254740991

local Migrations: { Migration } = {
	-- 1 to 2. Coins moved out of the save and into the backend ledger in M2. Nothing is thrown away.
	-- The old balance is kept as LegacyCoins, and EconomyService credits it to the ledger once.
	-- A fraction is rounded down so the credit never pays more than was saved, and anything that
	-- is not a real positive number was never a balance, so it is dropped. SaveGate only lets a
	-- server that talks to the ledger run this one.
	function(Data)
		local Coins = Data.Coins
		Data.Coins = nil
		if type(Coins) == "number" and Coins == Coins and Coins >= 1 and Coins <= MaxSafeInteger then
			Data.LegacyCoins = math.floor(Coins)
		end
	end,
}

return Migrations
