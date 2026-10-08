import { z } from 'zod';
import { errorBody } from '../../platform/http.js';
import type { ZodApp } from '../../platform/http.js';
import type { GuardFor } from '../identity/guards.js';
import { userIdParams } from './params.js';
import type { PlayersService } from './playersService.js';

export const walletSchema = z.object({ userId: z.number().int(), balance: z.number().int() });
const gameErrors = { 400: errorBody, 401: errorBody, 403: errorBody, 404: errorBody, 429: errorBody };
const bearer = [{ bearer: [] }];

export function registerPlayerRoutes(app: ZodApp, deps: { players: PlayersService; guardFor: GuardFor }): void {
  const economy = deps.guardFor('game:economy');

  app.post(
    '/v1/players/:userId/sessions',
    {
      onRequest: economy,
      schema: { tags: ['players'], summary: 'A player joined a game server', security: bearer, params: userIdParams, response: { 200: walletSchema, ...gameErrors } },
    },
    (request) => deps.players.join(request.params.userId),
  );

  app.post(
    '/v1/players/:userId/sessions/end',
    {
      onRequest: economy,
      schema: { tags: ['players'], summary: 'A player left a game server', security: bearer, params: userIdParams, response: { 204: z.null(), ...gameErrors } },
    },
    async (request, reply) => {
      await deps.players.leave(request.params.userId);
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/v1/players/:userId/wallet',
    {
      onRequest: economy,
      schema: { tags: ['players'], security: bearer, params: userIdParams, response: { 200: walletSchema, ...gameErrors } },
    },
    (request) => deps.players.wallet(request.params.userId),
  );
}
