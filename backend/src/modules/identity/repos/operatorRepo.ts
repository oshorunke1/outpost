import { randomUUID } from 'node:crypto';
import type { Clock } from '../../../platform/clock.js';
import { isDuplicateKey, withTransaction } from '../../../platform/db.js';
import type { Db, RowDataPacket } from '../../../platform/db.js';

export interface Operator {
  id: string;
  email: string;
  passwordHash: string;
  tokenVersion: number;
  scopes: string[];
}

export interface NewOperator {
  email: string;
  passwordHash: string;
  scopes: readonly string[];
}

export interface OperatorRepo {
  findByEmail(email: string): Promise<Operator | null>;
  findById(id: string): Promise<Operator | null>;
  create(input: NewOperator): Promise<Operator>;
  setPasswordHash(id: string, passwordHash: string): Promise<void>;
  bumpTokenVersion(id: string): Promise<number>;
}

export class EmailTakenError extends Error {
  constructor() {
    super('an operator with this email already exists');
    this.name = 'EmailTakenError';
  }
}

// THE one email normalizer: trim, Unicode NFC, lowercase. The repo, the login limiter and the
// routes all import this same function, so an address is one key everywhere. The operators.email
// column is utf8mb4_bin, so only addresses that normalize to identical bytes are the same account.
// An accent is a real difference, but the NFC and NFD spellings of one accent are not.
export function normalizeEmail(email: string): string {
  return email.trim().normalize('NFC').toLowerCase();
}

export function createMemoryOperatorRepo(): OperatorRepo {
  const byId = new Map<string, Operator>();
  const copy = (operator: Operator): Operator => ({ ...operator, scopes: [...operator.scopes] });
  const byEmail = (email: string) => [...byId.values()].find((o) => o.email === normalizeEmail(email));

  return {
    async findByEmail(email) {
      const found = byEmail(email);
      return found ? copy(found) : null;
    },
    async findById(id) {
      const found = byId.get(id);
      return found ? copy(found) : null;
    },
    async create(input) {
      if (byEmail(input.email)) throw new EmailTakenError();
      const operator: Operator = {
        id: randomUUID(),
        email: normalizeEmail(input.email),
        passwordHash: input.passwordHash,
        tokenVersion: 1,
        scopes: [...input.scopes],
      };
      byId.set(operator.id, operator);
      return copy(operator);
    },
    async setPasswordHash(id, passwordHash) {
      const found = byId.get(id);
      if (found) found.passwordHash = passwordHash;
    },
    async bumpTokenVersion(id) {
      const found = byId.get(id);
      if (!found) throw new Error(`no operator ${id}`);
      found.tokenVersion += 1;
      return found.tokenVersion;
    },
  };
}

interface OperatorRow extends RowDataPacket {
  operator_id: string;
  email: string;
  password_hash: string;
  token_version: number;
  scopes: string[];
}

function toOperator(row: OperatorRow): Operator {
  return {
    id: row.operator_id,
    email: row.email,
    passwordHash: row.password_hash,
    tokenVersion: Number(row.token_version),
    scopes: row.scopes,
  };
}

export function createMysqlOperatorRepo(db: Db, clock: Clock): OperatorRepo {
  return {
    async findByEmail(email) {
      const [rows] = await db.execute<OperatorRow[]>(
        'SELECT operator_id, email, password_hash, token_version, scopes FROM operators WHERE email = ?',
        [normalizeEmail(email)],
      );
      return rows[0] ? toOperator(rows[0]) : null;
    },
    async findById(id) {
      const [rows] = await db.execute<OperatorRow[]>(
        'SELECT operator_id, email, password_hash, token_version, scopes FROM operators WHERE operator_id = ?',
        [id],
      );
      return rows[0] ? toOperator(rows[0]) : null;
    },
    async create(input) {
      const operator: Operator = {
        id: randomUUID(),
        email: normalizeEmail(input.email),
        passwordHash: input.passwordHash,
        tokenVersion: 1,
        scopes: [...input.scopes],
      };
      try {
        // The unique key does the uniqueness check. A read-then-write would race; this cannot.
        await db.execute(
          'INSERT INTO operators (operator_id, email, password_hash, token_version, scopes, created_at) VALUES (?, ?, ?, 1, ?, ?)',
          [operator.id, operator.email, operator.passwordHash, JSON.stringify(operator.scopes), new Date(clock.now())],
        );
      } catch (error) {
        if (isDuplicateKey(error)) throw new EmailTakenError();
        throw error;
      }
      return operator;
    },
    async setPasswordHash(id, passwordHash) {
      await db.execute('UPDATE operators SET password_hash = ? WHERE operator_id = ?', [passwordHash, id]);
    },
    async bumpTokenVersion(id) {
      return withTransaction(db, async (conn) => {
        await conn.execute('UPDATE operators SET token_version = token_version + 1 WHERE operator_id = ?', [id]);
        const [rows] = await conn.execute<RowDataPacket[]>('SELECT token_version FROM operators WHERE operator_id = ?', [id]);
        if (!rows[0]) throw new Error(`no operator ${id}`);
        return Number(rows[0].token_version);
      });
    },
  };
}
