import type { Clock } from '../../../platform/clock.js';
import { AppError } from '../../../platform/errors.js';
import { parseApiKeyHeader } from '../crypto/apiKey.js';
import type { PasswordHasher } from '../crypto/password.js';
import { ACCESS_TOKEN_TTL_SECONDS } from '../crypto/tokenService.js';
import type { TokenService } from '../crypto/tokenService.js';
import type { HitResult, SlidingWindowCounter } from '../limiter/slidingWindow.js';
import type { ServicePrincipal } from '../principal.js';
import type { ServiceClient, ServiceClientRepo } from '../repos/serviceClientRepo.js';
import { failClosed } from './authService.js';

export interface ServiceTokenGrant {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  scope: string;
}

export interface ServiceTokenService {
  exchange(input: { authorization: string | undefined; ip: string }): Promise<ServiceTokenGrant>;
  authenticate(accessToken: string): Promise<ServicePrincipal>;
}

export interface ServiceTokenServiceDeps {
  clients: ServiceClientRepo;
  tokens: TokenService;
  hasher: PasswordHasher;
  dummyHash: string;
  clock: Clock;
  // Verified exchanges per client id (SERVICE_TOKEN_LIMIT).
  perClient: SlidingWindowCounter;
  // Failed exchanges per caller IP (SERVICE_TOKEN_IP_FAILURE_LIMIT).
  ipFailures: SlidingWindowCounter;
}

// How long authenticate trusts a client lookup. A disabled client is cut off within this window.
export const CLIENT_CACHE_MS = 30_000;
const CLIENT_CACHE_MAX = 1_000;

// The exchange answers a bad key with "WWW-Authenticate: ApiKey", the scheme this endpoint takes.
// Routes that take the resulting token challenge with Bearer instead (see guards.ts).
const invalidKey = () =>
  new AppError(401, 'invalid_api_key', 'The API key is not valid', { headers: { 'www-authenticate': 'ApiKey' } });
const unauthorized = () =>
  new AppError(401, 'unauthorized', 'Missing or invalid bearer token', { headers: { 'www-authenticate': 'Bearer' } });

function rateLimited(result: HitResult): AppError {
  return new AppError(429, 'rate_limited', 'Too many token requests', { headers: { 'retry-after': String(result.retryAfterSeconds) } });
}

// Client credentials: a long-lived API key buys a 15 minute RS256 token carrying the client's scopes.
// A leaked key is bounded by those scopes, the per-client limits and the per-transaction caps.
//
// Rate limits. The client id in a key is public, so a counter keyed on it alone would let anyone
// starve the real game server by sending bad keys under its id. So the per-client counter only
// counts exchanges whose secret verified, and failures count against the caller's IP, which comes
// from the socket or a trusted proxy (trustProxy is a CIDR list), never from a header the caller sets.
// The IP check is a peek that runs before any hash work, so a blocked IP costs almost nothing.
export function createServiceTokenService(deps: ServiceTokenServiceDeps): ServiceTokenService {
  const cache = new Map<string, { client: ServiceClient | null; fetchedAt: number }>();

  async function lookup(clientId: string): Promise<ServiceClient | null> {
    const now = deps.clock.now();
    const cached = cache.get(clientId);
    if (cached && now - cached.fetchedAt < CLIENT_CACHE_MS && now >= cached.fetchedAt) return cached.client;
    const client = await deps.clients.findById(clientId);
    cache.delete(clientId);
    if (cache.size >= CLIENT_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(clientId, { client, fetchedAt: now });
    return client;
  }

  async function fail(ipKey: string): Promise<never> {
    await failClosed(() => deps.ipFailures.hit(ipKey));
    throw invalidKey();
  }

  return {
    async exchange({ authorization, ip }) {
      const ipKey = `ip:${ip}`;
      const ipCheck = await failClosed(() => deps.ipFailures.peek(ipKey));
      if (!ipCheck.allowed) throw rateLimited(ipCheck);

      const key = parseApiKeyHeader(authorization);
      if (!key) return fail(ipKey);
      const client = await failClosed(() => deps.clients.findById(key.clientId));
      // Always one verify, against the dummy hash when the client is unknown, so an unknown client id
      // takes as long as a wrong secret and the two cannot be told apart.
      const secretOk = await deps.hasher.verify(client?.secretHash ?? deps.dummyHash, key.secret);
      if (!client || client.disabled || !secretOk) return fail(ipKey);

      const clientCheck = await failClosed(() => deps.perClient.hit(`client:${client.clientId}`));
      if (!clientCheck.allowed) throw rateLimited(clientCheck);
      const accessToken = await deps.tokens.signServiceToken({ clientId: client.clientId, scopes: client.scopes });
      return { accessToken, tokenType: 'Bearer', expiresIn: ACCESS_TOKEN_TTL_SECONDS, scope: client.scopes.join(' ') };
    },

    async authenticate(accessToken) {
      let claims;
      try {
        claims = await deps.tokens.verifyServiceToken(accessToken);
      } catch {
        throw unauthorized();
      }
      // A valid signature is not enough: the client must still exist and be enabled.
      const client = await failClosed(() => lookup(claims.clientId));
      if (!client || client.disabled) throw unauthorized();
      return { kind: 'service', clientId: claims.clientId, scopes: claims.scopes };
    },
  };
}
