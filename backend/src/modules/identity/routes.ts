import { z } from 'zod';
import { errorBody } from '../../platform/http.js';
import { named } from '../../platform/schemas.js';
import type { ZodApp } from '../../platform/http.js';
import type { TokenService } from './crypto/tokenService.js';
import { operatorGuard, requireOperator } from './guards.js';
import { normalizeEmail } from './repos/operatorRepo.js';
import type { AuthService } from './services/authService.js';
import type { ServiceTokenService } from './services/serviceTokenService.js';

// Argon2 cost grows with the input, so a cap keeps a huge password from tying up a worker.
const PASSWORD_MAX = 1024;
// Same shape parseRefreshToken accepts: <uuid>.<43 base64url chars>.
const REFRESH_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/;

const tokenPair = named(
  'TokenPair',
  z.object({
    accessToken: z.string(),
    refreshToken: z.string(),
    tokenType: z.literal('Bearer'),
    expiresIn: z.number().int(),
  }),
);

const sessionView = named(
  'Session',
  z.object({
    sessionId: z.uuid(),
    createdAt: z.string(),
    userAgent: z.string(),
    ip: z.string(),
    current: z.boolean(),
  }),
);
const sessionList = named('SessionList', z.object({ sessions: z.array(sessionView) }));

// Parsing with this object strips every member it does not list, so the secret members of a key (d, p, q
// and friends) can never reach the response even if a key set carried them by mistake.
const publicJwk = named('Jwk', z.object({ kty: z.string(), n: z.string(), e: z.string(), kid: z.string(), alg: z.string(), use: z.string() }));
const jwkSet = named('JwkSet', z.object({ keys: z.array(publicJwk) }));
const loginRequest = named('LoginRequest', z.object({ email: z.string().trim().min(3).max(254), password: z.string().min(1).max(PASSWORD_MAX) }).strict());
const refreshRequest = named('RefreshRequest', z.object({ refreshToken: z.string().regex(REFRESH_TOKEN) }).strict());
const serviceToken = named('ServiceToken', z.object({ accessToken: z.string(), tokenType: z.literal('Bearer'), expiresIn: z.number().int(), scope: z.string() }));
// Bodies over the app wide limit are refused with 413 before they are parsed.
const bodyErrors = { 400: errorBody, 413: errorBody };
const bearer = [{ bearer: [] }];

export function registerIdentityRoutes(
  app: ZodApp,
  deps: { tokens: TokenService; auth: AuthService; serviceTokens: ServiceTokenService },
): void {
  const operatorOnly = operatorGuard(deps.auth);

  app.post(
    '/auth/login',
    {
      schema: {
        tags: ['identity'],
        operationId: 'login',
        summary: 'Operator login with email and password',
        security: [],
        body: loginRequest,
        response: { 200: tokenPair, ...bodyErrors, 401: errorBody, 429: errorBody, 503: errorBody },
      },
    },
    (request) =>
      deps.auth.login({
        email: normalizeEmail(request.body.email),
        password: request.body.password,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? '',
      }),
  );

  app.post(
    '/auth/token/refresh',
    {
      schema: {
        tags: ['identity'],
        operationId: 'refreshToken',
        summary: 'Rotate a refresh token. Replaying an old one signs the session out.',
        security: [],
        body: refreshRequest,
        response: { 200: tokenPair, ...bodyErrors, 401: errorBody, 429: errorBody, 503: errorBody },
      },
    },
    (request) => deps.auth.refresh({ refreshToken: request.body.refreshToken, ip: request.ip }),
  );

  app.post(
    '/auth/logout',
    {
      onRequest: operatorOnly,
      schema: {
        tags: ['identity'],
        operationId: 'logout',
        summary: 'Sign out this session',
        security: bearer,
        response: { 204: z.undefined(), 401: errorBody, 503: errorBody },
      },
    },
    async (request, reply) => {
      await deps.auth.logout(requireOperator(request));
      return reply.code(204).send();
    },
  );

  app.post(
    '/auth/logout/all',
    {
      onRequest: operatorOnly,
      schema: {
        tags: ['identity'],
        operationId: 'logoutAll',
        summary: 'Sign out everywhere by bumping tokenVersion',
        security: bearer,
        response: { 204: z.undefined(), 401: errorBody, 503: errorBody },
      },
    },
    async (request, reply) => {
      await deps.auth.logoutAll(requireOperator(request));
      return reply.code(204).send();
    },
  );

  app.get(
    '/auth/sessions',
    {
      onRequest: operatorOnly,
      schema: {
        tags: ['identity'],
        operationId: 'listSessions',
        summary: 'List the sessions of this operator',
        security: bearer,
        response: { 200: sessionList, 401: errorBody, 503: errorBody },
      },
    },
    async (request) => ({ sessions: await deps.auth.listSessions(requireOperator(request)) }),
  );

  app.delete(
    '/auth/sessions/:id',
    {
      onRequest: operatorOnly,
      schema: {
        tags: ['identity'],
        operationId: 'revokeSession',
        summary: 'End one session of this operator',
        security: bearer,
        params: z.object({ id: z.uuid() }),
        response: { 204: z.undefined(), 400: errorBody, 401: errorBody, 404: errorBody, 503: errorBody },
      },
    },
    async (request, reply) => {
      await deps.auth.revokeSession(requireOperator(request), request.params.id);
      return reply.code(204).send();
    },
  );

  app.get(
    '/.well-known/jwks.json',
    {
      schema: {
        tags: ['identity'],
        operationId: 'getJwks',
        summary: 'Public signing keys',
        security: [],
        response: { 200: jwkSet },
      },
    },
    (_request, reply) => {
      void reply.header('cache-control', 'public, max-age=300');
      return { keys: deps.tokens.jwks().keys.map((key) => publicJwk.parse(key)) };
    },
  );

  // A 401 here carries "WWW-Authenticate: ApiKey", the scheme this route takes.
  app.post(
    '/auth/service-token',
    {
      schema: {
        tags: ['identity'],
        operationId: 'exchangeServiceToken',
        summary: 'Trade a service API key (Authorization: ApiKey opk_<clientId>.<secret>) for a 15 minute scoped token',
        security: [{ apiKey: [] }],
        response: {
          200: serviceToken,
          401: errorBody,
          429: errorBody,
          503: errorBody,
        },
      },
    },
    (request) => deps.serviceTokens.exchange({ authorization: request.headers.authorization, ip: request.ip }),
  );
}
