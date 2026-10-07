--!strict
-- Every cosmetic id in the game. The key and the value are always the same text,
-- so Validate.IsEnum can check a value with a single lookup.
local ItemId = {
	RedHat = "RedHat",
	GoldCrown = "GoldCrown",
}

return table.freeze(ItemId)
