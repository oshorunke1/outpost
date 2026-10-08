export const MINT_ACCOUNT = 'system:mint';
export const SINK_ACCOUNT = 'system:sink';

export function playerAccountId(userId: number): string {
  return `player:${userId}`;
}
