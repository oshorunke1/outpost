--!strict
-- Picks which DataStore a server should use, from the place id and whether we are in Studio.
-- The big rule is that only the real live place, running on a real server, ever touches live saves.

export type Places = { Live: number, Test: { number } }
export type StoreKind = "Live" | "Test" | "Mock"
export type Choice = { Kind: StoreKind, StoreName: string }

local StoreSelector = {}

StoreSelector.StoreNames = table.freeze({
	Live = "Outpost_Players_Live",
	Test = "Outpost_Players_Test",
	Mock = "Outpost_Players_Mock",
})

local function Make(Kind: StoreKind): Choice
	local Name = if Kind == "Live"
		then StoreSelector.StoreNames.Live
		elseif Kind == "Test" then StoreSelector.StoreNames.Test
		else StoreSelector.StoreNames.Mock
	return { Kind = Kind, StoreName = Name }
end

function StoreSelector.Choose(PlaceId: number, IsStudio: boolean, PlaceList: Places, ForceMock: boolean?): Choice
	if ForceMock then
		return Make("Mock")
	end
	if PlaceId ~= 0 and PlaceId == PlaceList.Live then
		-- Studio never writes to live saves, even when it is open on the live place.
		return if IsStudio then Make("Mock") else Make("Live")
	end
	if PlaceId ~= 0 and table.find(PlaceList.Test, PlaceId) ~= nil then
		return Make("Test")
	end
	-- Unknown or unpublished places get the mock store in Studio and the test store anywhere else.
	return if IsStudio then Make("Mock") else Make("Test")
end

return StoreSelector
