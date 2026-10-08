export interface SessionRecord {
  sessionId: string;
  operatorId: string;
  familyId: string;
  createdAt: number;
  userAgent: string;
  ip: string;
}

export interface SessionStore {
  create(session: SessionRecord, ttlSeconds: number): Promise<void>;
  get(sessionId: string): Promise<SessionRecord | null>;
  listForOperator(operatorId: string): Promise<SessionRecord[]>;
  delete(sessionId: string): Promise<SessionRecord | null>;
  deleteAllForOperator(operatorId: string): Promise<SessionRecord[]>;
}

export interface RefreshFamily {
  familyId: string;
  sessionId: string;
  operatorId: string;
  // The operator's tokenVersion at login. After logout-all bumps it, the family can never refresh.
  tokenVersion: number;
  currentHash: string;
}

// rotated  the presented hash was current, and nextHash replaced it
// reused   the presented hash is one this family already rotated away from, so a copy is in play
// unknown  the family exists but never issued this hash (forged or garbage), nothing changes
// missing  no such family (expired, revoked or never created)
export type RotateOutcome = 'rotated' | 'reused' | 'unknown' | 'missing';

// How many superseded hashes a family remembers for reuse detection.
export const SUPERSEDED_LIMIT = 10;

export interface RefreshStore {
  create(family: RefreshFamily, ttlSeconds: number): Promise<void>;
  get(familyId: string): Promise<RefreshFamily | null>;
  // Atomic. Swaps currentHash to nextHash only when presentedHash is current, and pushes the old
  // hash onto the family's superseded list (the newest SUPERSEDED_LIMIT, same expiry as the family).
  // It never revokes anything itself, it only reports.
  rotate(familyId: string, presentedHash: string, nextHash: string): Promise<RotateOutcome>;
  delete(familyId: string): Promise<void>;
}

export interface IdentityStores {
  sessions: SessionStore;
  refresh: RefreshStore;
}
