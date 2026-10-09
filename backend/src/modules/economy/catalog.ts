// The backend is the price authority. The game sends only an ItemId, and the Lune contract suite
// (Task 27, Task 31) checks these prices still match game/src/ReplicatedStorage/Shared/Configs/Shop.luau.
export const CATALOG = {
  RedHat: { price: 25 },
  GoldCrown: { price: 100 },
} as const satisfies Record<string, { price: number }>;

export type ItemId = keyof typeof CATALOG;
export const ITEM_IDS = Object.keys(CATALOG) as [ItemId, ...ItemId[]];

// Object.hasOwn, so inherited names like toString or __proto__ are never mistaken for items.
export function isItemId(value: unknown): value is ItemId {
  return typeof value === 'string' && Object.hasOwn(CATALOG, value);
}

export function priceOf(itemId: ItemId): number {
  if (!isItemId(itemId)) throw new RangeError(`unknown item ${String(itemId)}`);
  return CATALOG[itemId].price;
}
