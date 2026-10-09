import type { Redis } from '../../../platform/redis.js';
import { SUPERSEDED_LIMIT } from './types.js';
import type { IdentityStores, RefreshFamily, RotateOutcome, SessionRecord } from './types.js';

// Keyspace:
//   session:<sessionId>                 hash, absolute expiry
//   user:<operatorId>:sessions          set, index for listing and bulk revoke
//   refresh:{<familyId>}                hash, the family and its current token hash
//   refresh:{<familyId>}:superseded     list, the newest SUPERSEDED_LIMIT rotated-away hashes
// The braces are a Redis Cluster hash tag. Both refresh keys land in one slot, so the rotate script
// stays legal if this ever moves to a cluster.
const sessionKey = (id: string) => `session:${id}`;
const operatorSessionsKey = (operatorId: string) => `user:${operatorId}:sessions`;
const familyKey = (familyId: string) => `refresh:{${familyId}}`;
const supersededKey = (familyId: string) => `refresh:{${familyId}}:superseded`;

// Compare and swap in one script, so two refreshes with the same token can never both rotate.
// Redis runs scripts one at a time, and the loser finds its hash on the superseded list.
// The superseded list copies the family's remaining TTL, so it never outlives the family.
// Comparing with == is not constant time, which is fine here: these are SHA-256 digests of
// 256 bit secrets, so learning a prefix of one says nothing useful about any secret.
// KEYS[1] family, KEYS[2] superseded. ARGV[1] presented hash, ARGV[2] next hash, ARGV[3] limit.
const ROTATE_SCRIPT = `
local current = redis.call('HGET', KEYS[1], 'currentHash')
if not current then return 'missing' end
if current == ARGV[1] then
  redis.call('HSET', KEYS[1], 'currentHash', ARGV[2])
  redis.call('LPUSH', KEYS[2], ARGV[1])
  redis.call('LTRIM', KEYS[2], 0, tonumber(ARGV[3]) - 1)
  local ttl = redis.call('PTTL', KEYS[1])
  if ttl > 0 then redis.call('PEXPIRE', KEYS[2], ttl) end
  return 'rotated'
end
local superseded = redis.call('LRANGE', KEYS[2], 0, -1)
for _, hash in ipairs(superseded) do
  if hash == ARGV[1] then return 'reused' end
end
return 'unknown'
`;

const OUTCOMES: readonly RotateOutcome[] = ['rotated', 'reused', 'unknown', 'missing'];

function settle(results: [Error | null, unknown][] | null): unknown[] {
  if (!results) throw new Error('the redis transaction was aborted');
  return results.map(([error, value]) => {
    if (error) throw error;
    return value;
  });
}

function toSession(hash: Record<string, string>): SessionRecord | null {
  if (!hash.sessionId || !hash.operatorId || !hash.familyId) return null;
  return {
    sessionId: hash.sessionId,
    operatorId: hash.operatorId,
    familyId: hash.familyId,
    createdAt: Number(hash.createdAt),
    userAgent: hash.userAgent ?? '',
    ip: hash.ip ?? '',
  };
}

function toFamily(hash: Record<string, string>): RefreshFamily | null {
  const tokenVersion = Number(hash.tokenVersion);
  if (!hash.familyId || !hash.sessionId || !hash.operatorId || !hash.currentHash || !Number.isInteger(tokenVersion)) {
    return null;
  }
  return { familyId: hash.familyId, sessionId: hash.sessionId, operatorId: hash.operatorId, tokenVersion, currentHash: hash.currentHash };
}

export function createRedisIdentityStores(redis: Redis): IdentityStores {
  async function getSession(sessionId: string): Promise<SessionRecord | null> {
    return toSession(await redis.hgetall(sessionKey(sessionId)));
  }

  async function listForOperator(operatorId: string): Promise<SessionRecord[]> {
    const ids = await redis.smembers(operatorSessionsKey(operatorId));
    if (ids.length === 0) return [];
    const pipeline = redis.pipeline();
    for (const id of ids) pipeline.hgetall(sessionKey(id));
    const values = settle(await pipeline.exec());
    const live: SessionRecord[] = [];
    const stale: string[] = [];
    values.forEach((value, index) => {
      const record = toSession(value as Record<string, string>);
      if (record) live.push(record);
      else if (ids[index]) stale.push(ids[index]);
    });
    // Sessions that expired on their own are still in the index, so tidy them up while we are here.
    if (stale.length > 0) await redis.srem(operatorSessionsKey(operatorId), ...stale);
    return live.sort((a, b) => a.createdAt - b.createdAt);
  }

  return {
    sessions: {
      async create(session, ttlSeconds) {
        const key = sessionKey(session.sessionId);
        const index = operatorSessionsKey(session.operatorId);
        settle(
          await redis
            .multi()
            .hset(key, { ...session, createdAt: String(session.createdAt) })
            .expire(key, ttlSeconds)
            .sadd(index, session.sessionId)
            .expire(index, ttlSeconds)
            .exec(),
        );
      },
      get: getSession,
      listForOperator,
      async delete(sessionId) {
        const found = await getSession(sessionId);
        if (!found) return null;
        settle(await redis.multi().del(sessionKey(sessionId)).srem(operatorSessionsKey(found.operatorId), sessionId).exec());
        return found;
      },
      async deleteAllForOperator(operatorId) {
        const all = await listForOperator(operatorId);
        if (all.length === 0) return [];
        // SREM only the ids we listed. DEL on the whole index would also drop a session that a
        // concurrent login added after the list, and that session would then never be listed.
        const transaction = redis.multi();
        for (const s of all) transaction.del(sessionKey(s.sessionId));
        transaction.srem(operatorSessionsKey(operatorId), ...all.map((s) => s.sessionId));
        settle(await transaction.exec());
        return all;
      },
    },
    refresh: {
      async create(family, ttlSeconds) {
        const key = familyKey(family.familyId);
        settle(
          await redis
            .multi()
            .del(supersededKey(family.familyId))
            .hset(key, { ...family, tokenVersion: String(family.tokenVersion) })
            .expire(key, ttlSeconds)
            .exec(),
        );
      },
      async get(familyId) {
        return toFamily(await redis.hgetall(familyKey(familyId)));
      },
      async rotate(familyId, presentedHash, nextHash) {
        const reply = await redis.eval(
          ROTATE_SCRIPT,
          2,
          familyKey(familyId),
          supersededKey(familyId),
          presentedHash,
          nextHash,
          SUPERSEDED_LIMIT,
        );
        const outcome = OUTCOMES.find((candidate) => candidate === reply);
        if (!outcome) throw new Error('unexpected reply from the rotate script');
        return outcome;
      },
      async delete(familyId) {
        await redis.del(familyKey(familyId), supersededKey(familyId));
      },
    },
  };
}
