--!strict
-- PurchaseGuard keeps two things per player so a purchase can never be charged twice.
-- A lock, so only one purchase, reconcile or legacy credit runs for a player at a time. A click
-- while the join reconcile runs could otherwise buy an item the reconcile is about to grant.
-- A key for each item, kept until the backend gives a definite Grant or Refuse. After a RetryLater
-- the backend may already have charged, so the next click sends the same key and gets a replay of
-- that charge instead of a second one.
-- Nothing here touches game. The key maker is passed in.

export type Action = "Grant" | "Refuse" | "RetryLater"

type Fields = {
	NewKey: () -> string,
	Locked: { [number]: boolean },
	Keys: { [number]: { [string]: string } },
}

local PurchaseGuard = {}
PurchaseGuard.__index = PurchaseGuard

export type PurchaseGuard = typeof(setmetatable({} :: Fields, PurchaseGuard))

-- The backend's key rule, 8 to 128 letters, digits, colons, underscores or dashes.
local function IsKey(Key: any): boolean
	return type(Key) == "string" and #Key >= 8 and #Key <= 128 and string.match(Key, "^[%w:_%-]+$") ~= nil
end

function PurchaseGuard.new(NewKey: () -> string): PurchaseGuard
	local Object: Fields = { NewKey = NewKey, Locked = {}, Keys = {} }
	return setmetatable(Object, PurchaseGuard)
end

-- True when this caller now holds the player's lock. It never waits.
function PurchaseGuard.TryLock(self: PurchaseGuard, UserId: number): boolean
	if self.Locked[UserId] then
		return false
	end
	self.Locked[UserId] = true
	return true
end

function PurchaseGuard.Unlock(self: PurchaseGuard, UserId: number)
	self.Locked[UserId] = nil
end

-- The key for this player and item, the same one until Settle hears a Grant or a Refuse.
function PurchaseGuard.KeyFor(self: PurchaseGuard, UserId: number, ItemId: string): string
	local ForPlayer = self.Keys[UserId]
	if ForPlayer == nil then
		ForPlayer = {}
		self.Keys[UserId] = ForPlayer
	end
	local Existing = ForPlayer[ItemId]
	if Existing ~= nil then
		return Existing
	end
	local Key = self.NewKey()
	if not IsKey(Key) then
		error(`the purchase key maker gave {Key}, which is not an idempotency key`, 2)
	end
	ForPlayer[ItemId] = Key
	return Key
end

function PurchaseGuard.Settle(self: PurchaseGuard, UserId: number, ItemId: string, Action: Action)
	if Action == "RetryLater" then
		return
	end
	local ForPlayer = self.Keys[UserId]
	if ForPlayer ~= nil then
		ForPlayer[ItemId] = nil
	end
end

-- The player left, so their keys can go. Anything still unsettled is fixed by the reconcile on
-- their next join, because an unacknowledged purchase is always granted then.
-- A purchase that is still running keeps the lock and the keys. If the player came straight back
-- to this server, a new click could otherwise make a second charge while the first is in flight.
function PurchaseGuard.Forget(self: PurchaseGuard, UserId: number)
	if self.Locked[UserId] then
		return
	end
	self.Keys[UserId] = nil
end

return PurchaseGuard
