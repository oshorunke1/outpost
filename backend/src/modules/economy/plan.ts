import { canonicalJson, sha256Hex } from '../../platform/canonicalJson.js';
import { MINT_ACCOUNT, SINK_ACCOUNT, playerAccountId } from './accounts.js';
import { isItemId, priceOf } from './catalog.js';
import type { ItemId } from './catalog.js';

export const EARN_REASONS = ['orbs'] as const;
// A cap per transaction bounds what one leaked game key can mint per call (spec section 4.2).
export const MAX_EARN_PER_TRANSACTION = 1000;

export type TransactionKind = 'earn' | 'purchase' | 'refund';

export type TransactionRequest =
  | { kind: 'earn'; userId: number; amount: number; reason: (typeof EARN_REASONS)[number] }
  | { kind: 'purchase'; userId: number; itemId: ItemId };

export interface PlannedEntry {
  accountId: string;
  amount: number;
}

export interface Plan {
  kind: TransactionKind;
  userId: number;
  playerDelta: number; // signed change to the player's wallet, always equal to the player's entry
  reason: string;
  itemId: ItemId | null;
  entries: PlannedEntry[];
}

export interface RefundSource {
  transactionId: string;
  kind: TransactionKind;
  userId: number;
  itemId: ItemId | null;
  entries: readonly PlannedEntry[];
}

// Money is whole Coins. Every amount and every running total must stay a safe integer, or the
// double-entry arithmetic would silently round.
function assertWhole(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${what} must be a safe whole number, got ${String(value)}`);
}

export function sumEntries(entries: readonly PlannedEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    assertWhole(entry.amount, 'entry amount');
    total += entry.amount;
    assertWhole(total, 'entry total');
  }
  return total;
}

function assertUserId(userId: number): void {
  if (!Number.isSafeInteger(userId) || userId < 1) throw new RangeError(`userId must be a positive whole number, got ${String(userId)}`);
}

function playerDeltaOf(userId: number, entries: readonly PlannedEntry[]): number {
  const player = playerAccountId(userId);
  return sumEntries(entries.filter((entry) => entry.accountId === player));
}

// Pure double-entry planning. No database here, so the zero-sum property is checked with fast-check.
// The types already forbid bad input; the runtime checks are for callers that cast, and for the
// route schema ever drifting from these rules.
export function planTransaction(request: TransactionRequest): Plan {
  assertUserId(request.userId);
  const player = playerAccountId(request.userId);
  switch (request.kind) {
    case 'earn': {
      const { amount, reason } = request;
      if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 1 || amount > MAX_EARN_PER_TRANSACTION) {
        throw new RangeError(`earn amount must be a whole number from 1 to ${MAX_EARN_PER_TRANSACTION}, got ${String(amount)}`);
      }
      if (!(EARN_REASONS as readonly string[]).includes(reason)) throw new RangeError(`unknown earn reason ${String(reason)}`);
      return {
        kind: 'earn',
        userId: request.userId,
        playerDelta: amount,
        reason,
        itemId: null,
        entries: [
          { accountId: MINT_ACCOUNT, amount: -amount },
          { accountId: player, amount },
        ],
      };
    }
    case 'purchase': {
      if (!isItemId(request.itemId)) throw new RangeError(`unknown item ${String(request.itemId)}`);
      const price = priceOf(request.itemId);
      return {
        kind: 'purchase',
        userId: request.userId,
        playerDelta: -price,
        reason: 'shop',
        itemId: request.itemId,
        entries: [
          { accountId: player, amount: -price },
          { accountId: SINK_ACCOUNT, amount: price },
        ],
      };
    }
    default:
      throw new RangeError(`unknown transaction kind ${String((request as { kind: unknown }).kind)}`);
  }
}

// A refund is a new compensating transaction with every entry negated. Rows are never edited.
// Refunding a refund is refused, so a correction can never be undone by a second correction;
// the database backs the "once" half with the unique key on refund_of.
export function planRefund(source: RefundSource): Plan {
  if (source.kind === 'refund') throw new RangeError('a refund cannot itself be refunded');
  assertUserId(source.userId);
  if (source.entries.length === 0) throw new RangeError('a refund source must have entries');
  for (const entry of source.entries) {
    if (entry.amount === 0) throw new RangeError('a refund source cannot have a zero entry');
  }
  if (sumEntries(source.entries) !== 0) throw new RangeError('a refund source must sum to zero');
  const entries = source.entries.map((entry) => ({ accountId: entry.accountId, amount: -entry.amount }));
  return {
    kind: 'refund',
    userId: source.userId,
    playerDelta: playerDeltaOf(source.userId, entries),
    reason: 'refund',
    itemId: source.itemId,
    entries,
  };
}

// The principal is a member of the hashed object, not a prefix glued onto the text, so the same
// body from a different caller always hashes differently and no principal and body pair can be
// shifted into another that collides.
export function requestHash(principal: string, body: unknown): string {
  return sha256Hex(canonicalJson({ principal, body }));
}
