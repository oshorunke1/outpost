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
      // The players row is an upsert, so racing joins all succeed and leave one row; first_seen_at
      // is never in the UPDATE part. The account and balance rows are checked with a plain read
      // first and only inserted when missing, so a rejoin takes no lock on them (S3-F3). The ledger
      // holds the balance row FOR UPDATE and then needs a shared lock on this players row through
      // fk_ledger_player; a rejoin that held the players row and then waited on the balance row
      // would close that cycle into a deadlock. INSERT IGNORE would not do: on a duplicate it still
      // takes a shared lock on the existing row, and it turns other errors into warnings. Rows are
      // never deleted, so a row seen once stays.
      await withTransaction(db, async (conn) => {
        await conn.execute(
          'INSERT INTO players (roblox_user_id, first_seen_at, last_seen_at) VALUES (?, ?, ?) AS new ON DUPLICATE KEY UPDATE last_seen_at = new.last_seen_at',
          [userId, now, now],
        );
        const [existing] = await conn.execute<RowDataPacket[]>('SELECT 1 FROM account_balances WHERE account_id = ?', [account]);
        if (existing[0]) return;
        // First join only. Two first joins can race here, so both writes are no-op upserts.
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
