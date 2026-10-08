import type { Clock } from '../../../platform/clock.js';
import type { Db, RowDataPacket } from '../../../platform/db.js';
import type { Scope } from '../scopes.js';

// A machine caller such as the game server. Only an Argon2id hash of its secret is ever stored.
export interface ServiceClient {
  clientId: string;
  secretHash: string;
  scopes: Scope[];
  disabled: boolean;
}

export interface ServiceClientRepo {
  findById(clientId: string): Promise<ServiceClient | null>;
  // Creates the client, or replaces its secret hash and scopes. Never changes `disabled`.
  upsert(input: { clientId: string; secretHash: string; scopes: readonly Scope[] }): Promise<void>;
  setDisabled(clientId: string, disabled: boolean): Promise<void>;
}

export function createMemoryServiceClientRepo(): ServiceClientRepo {
  const clients = new Map<string, ServiceClient>();
  return {
    async findById(clientId) {
      const found = clients.get(clientId);
      return found ? { ...found, scopes: [...found.scopes] } : null;
    },
    async upsert({ clientId, secretHash, scopes }) {
      clients.set(clientId, { clientId, secretHash, scopes: [...scopes], disabled: clients.get(clientId)?.disabled ?? false });
    },
    async setDisabled(clientId, disabled) {
      const found = clients.get(clientId);
      if (found) found.disabled = disabled;
    },
  };
}

interface ClientRow extends RowDataPacket {
  client_id: string;
  secret_hash: string;
  scopes: Scope[];
  disabled: number;
}

export function createMysqlServiceClientRepo(db: Db, clock: Clock): ServiceClientRepo {
  return {
    async findById(clientId) {
      const [rows] = await db.execute<ClientRow[]>(
        'SELECT client_id, secret_hash, scopes, disabled FROM service_clients WHERE client_id = ?',
        [clientId],
      );
      const row = rows[0];
      return row ? { clientId: row.client_id, secretHash: row.secret_hash, scopes: row.scopes, disabled: row.disabled === 1 } : null;
    },
    async upsert({ clientId, secretHash, scopes }) {
      const now = new Date(clock.now());
      await db.execute(
        'INSERT INTO service_clients (client_id, secret_hash, scopes, disabled, created_at, rotated_at) VALUES (?, ?, ?, FALSE, ?, ?) AS new ON DUPLICATE KEY UPDATE secret_hash = new.secret_hash, scopes = new.scopes, rotated_at = new.rotated_at',
        [clientId, secretHash, JSON.stringify(scopes), now, now],
      );
    },
    async setDisabled(clientId, disabled) {
      await db.execute('UPDATE service_clients SET disabled = ? WHERE client_id = ?', [disabled, clientId]);
    },
  };
}
