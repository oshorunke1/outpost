import type { Clock } from '../../platform/clock.js';
import { withTransaction } from '../../platform/db.js';
import type { Db, ResultSetHeader, RowDataPacket } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import { playerAccountId } from '../economy/accounts.js';

export interface Wallet {
  userId: number;
  balance: number;
}

export interface PlayersService {
  join(userId: number): Promise<Wallet>;
  leave(userId: number): Promise<void>;
  wallet(userId: number): Promise<Wallet>;
}

const notFound = () => new AppError(404, 'player_not_found', 'This player has not joined yet');

export function createMemoryPlayersService(): PlayersService {
  const balances = new Map<number, number>();
  return {
    async join(userId) {
      if (!balances.has(userId)) balances.set(userId, 0);
      return { userId, balance: balances.get(userId) ?? 0 };
    },
    async leave(userId) {
      if (!balances.has(userId)) throw notFound();
    },
    async wallet(userId) {
      const balance = balances.get(userId);
      if (balance === undefined) throw notFound();
      return { userId, balance };
    },
  };
}

export function createMysqlPlayersService(db: Db, clock: Clock): PlayersService {
  async function wallet(userId: number): Promise<Wallet> {
    const [rows] = await db.execute<RowDataPacket[]>('SELECT balance FROM account_balances WHERE account_id = ?', [playerAccountId(userId)]);
    if (!rows[0]) throw notFound();
    return { userId, balance: Number(rows[0].balance) };
  }

  return {
    async join(userId) {
      const now = new Date(clock.now());
      const account = playerAccountId(userId);
      // Every write is an upsert on a unique key, so racing joins for one player all succeed and
      // leave one player row, one account and one balance. first_seen_at is never in the UPDATE part.
      await withTransaction(db, async (conn) => {
        await conn.execute(
          'INSERT INTO players (roblox_user_id, first_seen_at, last_seen_at) VALUES (?, ?, ?) AS new ON DUPLICATE KEY UPDATE last_seen_at = new.last_seen_at',
          [userId, now, now],
        );
        await conn.execute(
          "INSERT INTO accounts (account_id, kind, roblox_user_id, created_at) VALUES (?, 'player', ?, ?) ON DUPLICATE KEY UPDATE account_id = account_id",
          [account, userId, now],
        );
        await conn.execute(
          'INSERT INTO account_balances (account_id, balance, updated_at) VALUES (?, 0, ?) ON DUPLICATE KEY UPDATE account_id = account_id',
          [account, now],
        );
      });
      return wallet(userId);
    },
    async leave(userId) {
      const [result] = await db.execute<ResultSetHeader>('UPDATE players SET last_left_at = ? WHERE roblox_user_id = ?', [
        new Date(clock.now()),
        userId,
      ]);
      if (result.affectedRows === 0) throw notFound();
    },
    wallet,
  };
}
