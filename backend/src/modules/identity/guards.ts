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

const unauthorized = () => new AppError(401, 'unauthorized', 'Missing or invalid bearer token');

// Runs as an onRequest hook, before the body is read, so anonymous callers cost almost nothing.
// bearerToken is strict: exactly "Bearer <token>", one space, nothing after. authenticate only
// accepts operator access tokens, so a service token is a 401 here too.
export function operatorGuard(auth: AuthService) {
  return async (request: FastifyRequest): Promise<void> => {
    const token = bearerToken(request.headers.authorization);
    if (!token) throw unauthorized();
    request.principal = await auth.authenticate(token);
  };
}

export function requireOperator(request: FastifyRequest): OperatorPrincipal {
  const principal = request.principal;
  if (!principal || principal.kind !== 'operator') throw unauthorized();
  return principal;
}
