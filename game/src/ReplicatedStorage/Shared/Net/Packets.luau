--!strict
-- The one list of every remote in the game. NetGuard builds its checks and rate limits from this,
-- NetClient reads it to know which way each packet goes, and the manifest export reads it too.
-- That is why this file must never require anything.
-- Payload uses the spec format that Validate.FromSpec understands.
-- RateLimit is a token bucket per player for that packet. Capacity is the burst size.
-- Keep the list in name order.

export type Direction = "ClientToServer" | "ServerToClient"
export type PacketDef = {
	Name: string,
	Direction: Direction,
	Payload: { [string]: any },
	RateLimit: { Capacity: number, RefillPerSecond: number }?,
}

local List: { PacketDef } = {
	{
		Name = "Orb.Collect",
		Direction = "ClientToServer",
		Payload = { Kind = "Struct", Fields = { OrbId = { Kind = "Integer", Min = 1, Max = 1000000 } } },
		RateLimit = { Capacity = 8, RefillPerSecond = 4 },
	},
	{
		Name = "Profile.RequestSnapshot",
		Direction = "ClientToServer",
		Payload = { Kind = "None" },
		RateLimit = { Capacity = 2, RefillPerSecond = 0.5 },
	},
	{
		Name = "Profile.Snapshot",
		Direction = "ServerToClient",
		Payload = {
			Kind = "Struct",
			Fields = {
				Coins = { Kind = "Integer", Min = 0, Max = 1000000000 },
				OwnedItems = { Kind = "List", MaxLength = 64, Item = { Kind = "Enum", Enum = "ItemId" } },
			},
		},
	},
	{
		Name = "Shop.Buy",
		Direction = "ClientToServer",
		Payload = { Kind = "Struct", Fields = { ItemId = { Kind = "Enum", Enum = "ItemId" } } },
		RateLimit = { Capacity = 3, RefillPerSecond = 1 },
	},
	{
		Name = "Shop.Result",
		Direction = "ServerToClient",
		Payload = {
			Kind = "Struct",
			Fields = { ItemId = { Kind = "Enum", Enum = "ItemId" }, Outcome = { Kind = "String", MaxLength = 16 } },
		},
	},
}

local ByName: { [string]: PacketDef } = {}
for _, Def in List do
	ByName[Def.Name] = Def
end

return table.freeze({
	List = table.freeze(List),
	ByName = table.freeze(ByName),
})
