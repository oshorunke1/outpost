import type { TokenService } from '../../src/modules/identity/crypto/tokenService.js';
import { GAME_SCOPES } from '../../src/modules/identity/scopes.js';
import { GAME_CLIENT_ID } from '../../src/modules/identity/seed.js';

// A service token for the game-server client. The client must exist and be enabled where it is
// checked: createMemoryAppDeps registers it, integration tests seed it.
export function gameToken(tokens: TokenService, scopes: readonly string[] = GAME_SCOPES): Promise<string> {
  return tokens.signServiceToken({ clientId: GAME_CLIENT_ID, scopes });
}

export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}
