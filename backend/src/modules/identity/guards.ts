import type { FastifyRequest } from 'fastify';
import { AppError } from '../../platform/errors.js';
import { bearerToken } from '../../platform/http.js';
import type { OperatorPrincipal, Principal } from './principal.js';
import type { AuthService } from './services/authService.js';

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

export function requireOperator(request: FastifyRequest): OperatorPrincipal {
  const principal = request.principal;
  if (!principal || principal.kind !== 'operator') throw unauthorized();
  return principal;
}
