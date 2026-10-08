import type { FastifyRequest } from 'fastify';
import { AppError } from '../../platform/errors.js';
import { bearerToken } from '../../platform/http.js';
import type { TokenBucketLimiter } from './limiter/tokenBucket.js';
import type { OperatorPrincipal, Principal, ServicePrincipal } from './principal.js';
import type { Scope } from './scopes.js';
import type { AuthService } from './services/authService.js';
import type { ServiceTokenService } from './services/serviceTokenService.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

// RFC 6750: a 401 on a bearer protected route says which scheme it wants.
const CHALLENGE = { 'www-authenticate': 'Bearer' };
const unauthorized = () => new AppError(401, 'unauthorized', 'Missing or invalid bearer token', { headers: CHALLENGE });

// Runs as an onRequest hook, before the body is read, so anonymous callers cost almost nothing.
// bearerToken is strict: exactly "Bearer <token>", one space, nothing after. authenticate only
// accepts operator access tokens, so a service token is a 401 here too.
export function operatorGuard(auth: AuthService) {
  return async (request: FastifyRequest): Promise<void> => {
    const token = bearerToken(request.headers.authorization);
    if (!token) throw unauthorized();
    try {
      request.principal = await auth.authenticate(token);
    } catch (error) {
      // A token that parsed but did not authenticate gets the same challenge. 503s pass through.
      if (error instanceof AppError && error.statusCode === 401) throw unauthorized();
      throw error;
    }
  };
}

export type Guard = (request: FastifyRequest) => Promise<void>;
export type GuardFor = (scope: Scope) => Guard;

// For routes the game server (or another service client) calls. Any 401 carries the Bearer
// challenge. A token that is fine but lacks the scope is a 403 that does not say which scope the
// route wants, and the per-client bucket only runs once the caller is known and allowed.
export function serviceGuard(serviceTokens: ServiceTokenService, limiter: TokenBucketLimiter, scope: Scope): Guard {
  return async (request) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) throw unauthorized();
    let principal: ServicePrincipal;
    try {
      principal = await serviceTokens.authenticate(token);
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 401) throw unauthorized();
      throw error;
    }
    if (!principal.scopes.includes(scope)) {
      throw new AppError(403, 'insufficient_scope', 'This token cannot use this route');
    }
    if (!limiter.allow(principal.clientId)) {
      throw new AppError(429, 'rate_limited', 'Too many requests', {
        headers: { 'retry-after': String(limiter.retryAfterSeconds(principal.clientId)) },
      });
    }
    request.principal = principal;
  };
}

export function requireService(request: FastifyRequest): ServicePrincipal {
  const principal = request.principal;
  if (!principal || principal.kind !== 'service') throw unauthorized();
  return principal;
}

export function requireOperator(request: FastifyRequest): OperatorPrincipal {
  const principal = request.principal;
  if (!principal || principal.kind !== 'operator') throw unauthorized();
  return principal;
}
