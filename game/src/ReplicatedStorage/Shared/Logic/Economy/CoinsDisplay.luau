--!strict
-- CoinsDisplay decides what the HUD shows for Coins. A balance is only shown when it is real.
-- Ready shows the number. Loading is a ledger player whose join has not landed yet. Paused is a
-- player whose save moved to the ledger, on a server that does not talk to it, so their Coins are
-- safe in the ledger but can't be shown here. The server works it out and sends it in the
-- snapshot, and the client turns it into text.
-- Nothing here touches game.

export type State = "Ready" | "Loading" | "Paused"

local CoinsDisplay = {}

-- The biggest Coins value the Profile.Snapshot packet carries.
CoinsDisplay.MaxCoins = 1000000000

local function Clean(Value: any): number
	if type(Value) ~= "number" or Value ~= Value then
		return 0
	end
	return math.clamp(math.floor(Value), 0, CoinsDisplay.MaxCoins)
end

-- Economy is the player's economy from SaveGate, or nil before the save loads.
function CoinsDisplay.For(
	Economy: string?,
	SaveCoins: number?,
	LedgerCoins: number,
	LedgerReady: boolean
): (number, State)
	if Economy == "Legacy" then
		return Clean(SaveCoins), "Ready"
	elseif Economy == "Ledger" and LedgerReady then
		return Clean(LedgerCoins), "Ready"
	elseif Economy == "Paused" then
		return 0, "Paused"
	end
	return 0, "Loading"
end

function CoinsDisplay.Text(Coins: number, State: string?): string
	if State == "Paused" then
		return "Coins paused"
	elseif State == "Loading" then
		return "Coins loading"
	end
	return `Coins {Coins}`
end

return CoinsDisplay
