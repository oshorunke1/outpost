--!strict
-- SaveSeq proves that a save we asked for really landed, the way ProfileService suggests for
-- purchase receipts. Before saving we put a bigger number in a meta tag. Meta tags are written in
-- the same DataStore update as the data, so once MetaTagsLatest shows our number or a later one,
-- a save that read the data after we bumped it is stored. A save that was already on its way
-- carries the old number, so it never counts.
-- Nothing here touches game.

local SaveSeq = {}

-- The meta tag that holds the number.
SaveSeq.Tag = "SaveSeq"

local function Read(Tags: { [string]: any }?): number?
	local Value = if type(Tags) == "table" then Tags[SaveSeq.Tag] else nil
	if type(Value) == "number" and Value == Value and Value % 1 == 0 and Value >= 1 and Value < math.huge then
		return Value
	end
	return nil
end

-- The number to tag the next save with, from the tags the profile holds now.
function SaveSeq.Next(Tags: { [string]: any }?): number
	return (Read(Tags) or 0) + 1
end

-- True when the tags from a finished save show Wanted or a later number.
function SaveSeq.Landed(Latest: { [string]: any }?, Wanted: number): boolean
	local Value = Read(Latest)
	return Value ~= nil and Value >= Wanted
end

return SaveSeq
