import { randomUUID } from 'node:crypto';
import type { Clock } from '../../../platform/clock.js';
import { AppError } from '../../../platform/errors.js';
import type { PasswordHasher } from '../crypto/password.js';
import { hashSecret, mintRefreshToken, parseRefreshToken } from '../crypto/refreshToken.js';
import { ACCESS_TOKEN_TTL_SECONDS } from '../crypto/tokenService.js';
import type { TokenService } from '../crypto/tokenService.js';
import type { LoginLimiter } from '../limiter/loginLimiter.js';
import type { SlidingWindowCounter } from '../limiter/slidingWindow.js';
import type { OperatorPrincipal } from '../principal.js';
import type { Operator, OperatorRepo } from '../repos/operatorRepo.js';
import type { RefreshStore, SessionStore } from '../stores/types.js';

// Sessions and refresh families share this absolute lifetime. Rotation never extends it.
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const USER_AGENT_MAX = 200;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

export interface SessionView {
  sessionId: string;
  createdAt: string;
  userAgent: string;
  ip: string;
  current: boolean;
}

export interface AuthServiceDeps {
  operators: OperatorRepo;
  sessions: SessionStore;
  refresh: RefreshStore;
  tokens: TokenService;
  hasher: PasswordHasher;
  // Computed once at composition with makeDummyHash, never per request.
  dummyHash: string;
  loginLimiter: LoginLimiter;
  refreshLimiter: SlidingWindowCounter;
  clock: Clock;
}

export interface AuthService {
  login(input: { email: string; password: string; ip: string; userAgent: string }): Promise<TokenPair>;
  refresh(input: { refreshToken: string; ip: string }): Promise<TokenPair>;
  logout(principal: OperatorPrincipal): Promise<void>;
  logoutAll(principal: OperatorPrincipal): Promise<void>;
  listSessions(principal: OperatorPrincipal): Promise<SessionView[]>;
  revokeSession(principal: OperatorPrincipal, sessionId: string): Promise<void>;
  authenticate(accessToken: string): Promise<OperatorPrincipal>;
}

const unauthorized = () => new AppError(401, 'unauthorized', 'Missing or invalid credentials');
const invalidCredentials = () => new AppError(401, 'invalid_credentials', 'Email or password is incorrect');
const invalidRefresh = () => new AppError(401, 'invalid_refresh_token', 'The refresh token is not valid');
// One answer for "no such session" and "someone else's session", so the route never confirms that
// another operator's session id exists.
const sessionNotFound = () => new AppError(404, 'session_not_found', 'No such session');

// The limiter counters, sessions and refresh families live in Redis, and operators in MySQL. If a
// store is unreachable, auth refuses service instead of running without rate limits or revocation
// (ADR 0014). AppErrors (401, 404, 429) pass through untouched. Anything else becomes a 503 whose
// message names no backend; the original error rides along as the cause for the server log only.
export async function failClosed<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'auth_unavailable', 'Authentication is temporarily unavailable', { cause: error });
  }
}

export function createAuthService(deps: AuthServiceDeps): AuthService {
  function signAccess(operator: Operator, sessionId: string): Promise<string> {
    return deps.tokens.signAccessToken({ userId: operator.id, tokenVersion: operator.tokenVersion, sessionId, scopes: operator.scopes });
  }

  function pair(accessToken: string, refreshToken: string): TokenPair {
    return { accessToken, refreshToken, tokenType: 'Bearer', expiresIn: ACCESS_TOKEN_TTL_SECONDS };
  }

  // Family first, so no refresh can start while the session is being torn down.
  async function endSession(familyId: string, sessionId: string): Promise<void> {
    await failClosed(async () => {
      await deps.refresh.delete(familyId);
      await deps.sessions.delete(sessionId);
    });
  }

  async function ownSession(principal: OperatorPrincipal, sessionId: string) {
    const session = await failClosed(() => deps.sessions.get(sessionId));
    return session && session.operatorId === principal.operatorId ? session : null;
  }

  return {
    async login({ email, password, ip, userAgent }) {
      // The limiter normalizes the raw email itself, the same way the repo does.
      await failClosed(() => deps.loginLimiter.check(ip, email));
      const operator = await failClosed(() => deps.operators.findByEmail(email));
      // Exactly one Argon2 verify on every path. An unknown email verifies against the dummy hash,
      // so it costs the same as a wrong password and the two cannot be told apart by timing.
      // (A corrupt stored hash fails fast inside verify, which only reveals a broken row.)
      const passwordOk = await deps.hasher.verify(operator?.passwordHash ?? deps.dummyHash, password);
      if (!operator || !passwordOk) throw invalidCredentials();

      const sessionId = randomUUID();
      const familyId = randomUUID();
      const minted = mintRefreshToken(familyId);
      const accessToken = await signAccess(operator, sessionId);
      await failClosed(async () => {
        await deps.sessions.create(
          { sessionId, operatorId: operator.id, familyId, createdAt: deps.clock.now(), userAgent: userAgent.slice(0, USER_AGENT_MAX), ip },
          REFRESH_TTL_SECONDS,
        );
        try {
          await deps.refresh.create(
            { familyId, sessionId, operatorId: operator.id, tokenVersion: operator.tokenVersion, currentHash: minted.hash },
            REFRESH_TTL_SECONDS,
          );
        } catch (error) {
          // Do not leave a session in the list that has no way to refresh.
          await deps.sessions.delete(sessionId).catch(() => undefined);
          throw error;
        }
      });
      return pair(accessToken, minted.token);
    },

    async refresh({ refreshToken, ip }) {
      const hit = await failClosed(() => deps.refreshLimiter.hit(ip));
      if (!hit.allowed) {
        throw new AppError(429, 'rate_limited', 'Too many refreshes, try again later', {
          headers: { 'retry-after': String(hit.retryAfterSeconds) },
        });
      }
      const parsed = parseRefreshToken(refreshToken);
      if (!parsed) throw invalidRefresh();
      const family = await failClosed(() => deps.refresh.get(parsed.familyId));
      if (!family) throw invalidRefresh();

      // Validate everything BEFORE rotating. If any check fails or any store errors here, the
      // presented token is untouched and still refreshes once the condition clears. A stale
      // tokenVersion means logout-all happened after this family was issued.
      const operator = await failClosed(() => deps.operators.findById(family.operatorId));
      if (!operator || operator.tokenVersion !== family.tokenVersion) throw invalidRefresh();
      const session = await failClosed(() => deps.sessions.get(family.sessionId));
      if (!session || session.operatorId !== operator.id || session.familyId !== family.familyId) throw invalidRefresh();

      // Everything that could still fail runs before the rotate too, so a rotate that succeeds is
      // always answered with the new pair. The one gap left is a reply lost on the wire after Redis
      // applied the rotate: the client then retries with a superseded token and the family is
      // revoked, which costs that operator a sign-in and nothing else.
      const next = mintRefreshToken(family.familyId);
      const accessToken = await signAccess(operator, session.sessionId);

      // The rotate is one atomic compare and swap. When two refreshes race with the same token,
      // exactly one rotates and the other finds its hash already superseded, so it reads as a
      // reuse and the family is revoked, the winner's new token included. The store cannot tell a
      // client that retried too fast from an attacker holding a copy, and it must not guess.
      const outcome = await failClosed(() => deps.refresh.rotate(family.familyId, hashSecret(parsed.secret), next.hash));
      switch (outcome) {
        case 'rotated':
          return pair(accessToken, next.token);
        case 'reused':
          // A token this family already rotated away from came back, so a copy is in play. End it all.
          await endSession(family.familyId, family.sessionId);
          throw new AppError(401, 'refresh_token_reused', 'This refresh token was already used. The session has been signed out.');
        case 'unknown': // never issued by this family: forged or garbage, so refuse and revoke nothing
        case 'missing': // revoked or expired between the read and the rotate
          throw invalidRefresh();
      }
    },

    async logout(principal) {
      const session = await ownSession(principal, principal.sessionId);
      if (session) await endSession(session.familyId, session.sessionId);
    },

    async logoutAll(principal) {
      // The bump comes first and is what actually matters: every access token already issued and
      // every refresh family carries the old version, so all of them stop working at once with no
      // denylist. Deleting the sessions afterwards is cleanup that also empties the session list.
      await failClosed(() => deps.operators.bumpTokenVersion(principal.operatorId));
      const ended = await failClosed(() => deps.sessions.deleteAllForOperator(principal.operatorId));
      await failClosed(async () => {
        for (const session of ended) await deps.refresh.delete(session.familyId);
      });
    },

    async listSessions(principal) {
      const sessions = await failClosed(() => deps.sessions.listForOperator(principal.operatorId));
      return sessions.map((s) => ({
        sessionId: s.sessionId,
        createdAt: new Date(s.createdAt).toISOString(),
        userAgent: s.userAgent,
        ip: s.ip,
        current: s.sessionId === principal.sessionId,
      }));
    },

    async revokeSession(principal, sessionId) {
      const session = await ownSession(principal, sessionId);
      if (!session) throw sessionNotFound();
      await endSession(session.familyId, session.sessionId);
    },

    async authenticate(accessToken) {
      let claims;
      try {
        claims = await deps.tokens.verifyAccessToken(accessToken);
      } catch {
        throw unauthorized();
      }
      const sessionId = claims.sessionId;
      if (!sessionId) throw unauthorized();
      const operator = await failClosed(() => deps.operators.findById(claims.userId));
      if (!operator || operator.tokenVersion !== claims.tokenVersion) throw unauthorized();
      // Checking the session makes logout take effect at once instead of when the token expires.
      const session = await failClosed(() => deps.sessions.get(sessionId));
      if (!session || session.operatorId !== operator.id) throw unauthorized();
      // Scopes come from the operator row, not the token, so pulling a scope takes effect on the
      // very next request instead of when the token expires.
      return { kind: 'operator', operatorId: operator.id, sessionId, scopes: [...operator.scopes] };
    },
  };
}
