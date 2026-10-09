export const MINT_ACCOUNT = 'system:mint';
export const SINK_ACCOUNT = 'system:sink';

export function playerAccountId(userId: number): string {
  return `player:${userId}`;
}

// Player accounts have a materialized balance row; system accounts are derived from entries.
export function isPlayerAccount(accountId: string): boolean {
  return accountId.startsWith('player:');
}
