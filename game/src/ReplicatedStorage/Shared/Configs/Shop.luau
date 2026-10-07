--!strict
-- What each cosmetic costs. The server reads prices only from here and never from a player.
-- The client may read this too, but only to show prices on screen.
local Shop: { [string]: { DisplayName: string, Price: number } } = {
	RedHat = { DisplayName = "Red Hat", Price = 25 },
	GoldCrown = { DisplayName = "Gold Crown", Price = 100 },
}

return table.freeze(Shop)
