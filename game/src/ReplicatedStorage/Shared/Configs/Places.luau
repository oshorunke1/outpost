--!strict
-- The place ids this game runs in. M1 has no published place, so Live is 0 and there are no Test places.
-- Fill these in when a real place exists. A place that is not listed never uses the Live store.
local Places: { Live: number, Test: { number } } = {
	Live = 0,
	Test = {},
}

return table.freeze(Places)
