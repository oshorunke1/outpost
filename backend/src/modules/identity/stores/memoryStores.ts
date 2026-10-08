import type { Clock } from '../../../platform/clock.js';
import { SUPERSEDED_LIMIT } from './types.js';
import type { IdentityStores, RefreshFamily, SessionRecord } from './types.js';

interface FamilyEntry {
  family: RefreshFamily;
  superseded: string[]; // newest first
  expiresAt: number;
}

// In-memory stand-ins with the same expiry and rotate semantics as Redis, driven by the injected
// clock. No method body awaits anything, so each call is atomic on the event loop, which is what
// the Lua script gives the Redis version.
export function createMemoryIdentityStores(clock: Clock): IdentityStores {
  const sessions = new Map<string, { record: SessionRecord; expiresAt: number }>();
  const families = new Map<string, FamilyEntry>();

  const liveSession = (id: string): SessionRecord | null => {
    const entry = sessions.get(id);
    if (!entry) return null;
    if (entry.expiresAt <= clock.now()) {
      sessions.delete(id);
      return null;
    }
    return entry.record;
  };
  const liveFamily = (id: string): FamilyEntry | null => {
    const entry = families.get(id);
    if (!entry) return null;
    if (entry.expiresAt <= clock.now()) {
      families.delete(id);
      return null;
    }
    return entry;
  };
  const listFor = (operatorId: string): SessionRecord[] =>
    [...sessions.keys()]
      .map(liveSession)
      .filter((s): s is SessionRecord => s !== null && s.operatorId === operatorId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((s) => ({ ...s }));

  return {
    sessions: {
      async create(session, ttlSeconds) {
        sessions.set(session.sessionId, { record: { ...session }, expiresAt: clock.now() + ttlSeconds * 1000 });
      },
      async get(sessionId) {
        const found = liveSession(sessionId);
        return found ? { ...found } : null;
      },
      async listForOperator(operatorId) {
        return listFor(operatorId);
      },
      async delete(sessionId) {
        const found = liveSession(sessionId);
        sessions.delete(sessionId);
        return found ? { ...found } : null;
      },
      async deleteAllForOperator(operatorId) {
        const all = listFor(operatorId);
        for (const s of all) sessions.delete(s.sessionId);
        return all;
      },
    },
    refresh: {
      async create(family, ttlSeconds) {
        families.set(family.familyId, { family: { ...family }, superseded: [], expiresAt: clock.now() + ttlSeconds * 1000 });
      },
      async get(familyId) {
        const found = liveFamily(familyId);
        return found ? { ...found.family } : null;
      },
      async rotate(familyId, presentedHash, nextHash) {
        const found = liveFamily(familyId);
        if (!found) return 'missing';
        if (found.family.currentHash === presentedHash) {
          found.superseded = [presentedHash, ...found.superseded].slice(0, SUPERSEDED_LIMIT);
          found.family.currentHash = nextHash;
          return 'rotated';
        }
        return found.superseded.includes(presentedHash) ? 'reused' : 'unknown';
      },
      async delete(familyId) {
        families.delete(familyId);
      },
    },
  };
}
