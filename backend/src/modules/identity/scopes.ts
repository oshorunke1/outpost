// Spec section 4.2. The game server never gets admin scopes, and only operators can decide approvals.
// The admin and approvals scopes are granted now and used by the M3 routes.
export const GAME_SCOPES = ['game:economy', 'game:telemetry', 'game:flags.read'] as const;
export const OPERATOR_SCOPES = [
  'admin:read',
  'admin:write.reversible',
  'approvals:request',
  'approvals:execute',
  'approvals:decide',
] as const;

export type GameScope = (typeof GAME_SCOPES)[number];
export type OperatorScope = (typeof OPERATOR_SCOPES)[number];
export type Scope = GameScope | OperatorScope;
