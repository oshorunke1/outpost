--!strict
-- LegacyCredit plans the one time credit of the Coins a player saved before the ledger existed.
-- The save keeps them as LegacyCoins until LegacyCredited is true. They go to the ledger as earns
-- with the legacy_migration reason, in chunks of at most 1000, which is the most one earn may carry.
-- Chunk n always has the key legacy, then the UserId, then n, and the chunks come out the same way
-- every time. So a server that crashed halfway, or before it marked the save, sends the very same
-- requests again, and the backend replays them instead of paying a second time.
-- Nothing here touches game.

export type Verdict = "Paid" | "Rejoin" | "Later" | "Refused"

local LegacyCredit = {}

-- MAX_EARN_PER_TRANSACTION in backend/src/modules/economy/plan.ts, and the spec checks it.
LegacyCredit.ChunkSize = 1000

-- A balance bigger than this is far past anything M1 could earn, so it is left in the save for an
-- operator to look at instead of being sent as a thousand earns.
LegacyCredit.MaxCoins = 1000000

local function IsWhole(Value: any, Low: number, High: number): boolean
	return type(Value) == "number" and Value == Value and Value % 1 == 0 and Value >= Low and Value <= High
end

-- The Coins still owed to the ledger, or nil when there are none or they were already credited.
function LegacyCredit.Owed(Data: { [string]: any }?): number?
	if Data == nil or Data.LegacyCredited == true then
		return nil
	end
	local Coins = Data.LegacyCoins
	return if IsWhole(Coins, 1, math.huge) then Coins else nil
end

-- The chunk amounts in order. Chunk n goes with key n.
function LegacyCredit.Chunks(Coins: number): { number }
	if not IsWhole(Coins, 1, LegacyCredit.MaxCoins) then
		error(`legacy Coins must be a whole number from 1 to {LegacyCredit.MaxCoins}, got {Coins}`, 2)
	end
	local Chunks: { number } = {}
	local Left = Coins
	while Left > 0 do
		local Chunk = math.min(Left, LegacyCredit.ChunkSize)
		table.insert(Chunks, Chunk)
		Left -= Chunk
	end
	return Chunks
end

-- What one chunk's answer means. Paid is a new credit or a replay of one. Rejoin is a 404, the
-- join has not landed yet, so the player joins again and the same key goes again. Later is
-- anything temporary, the same statuses EarnBatcher requeues. Refused is a definite no, such as a
-- 409 for a key used with a different amount, and the save is never marked so an operator can look.
function LegacyCredit.Classify(Status: number): Verdict
	if Status >= 200 and Status < 300 then
		return "Paid"
	end
	if Status == 404 then
		return "Rejoin"
	end
	if
		(Status <= 0 and Status ~= -4)
		or Status == 401
		or Status == 403
		or Status == 408
		or Status == 425
		or Status == 429
		or Status >= 500
	then
		return "Later"
	end
	return "Refused"
end

return LegacyCredit
