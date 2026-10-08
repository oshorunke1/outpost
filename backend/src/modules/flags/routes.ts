import { z } from 'zod';
import { errorBody } from '../../platform/http.js';
import type { ZodApp } from '../../platform/http.js';
import type { GuardFor } from '../identity/guards.js';
import type { FlagsService } from './flagsService.js';

export interface FlagRouteDeps {
  flags: FlagsService;
  guardFor: GuardFor;
}

// Read only for now. Flag writes (admin routes, revert, TTL, history) are planned (M3).
export function registerFlagRoutes(app: ZodApp, deps: FlagRouteDeps): void {
  app.get(
    '/v1/flags',
    {
      onRequest: deps.guardFor('game:flags.read'),
      schema: {
        tags: ['flags'],
        summary: 'Current flag values. The game keeps its last known values if this fails.',
        security: [{ bearer: [] }],
        response: {
          200: z.object({ flags: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])) }),
          401: errorBody,
          403: errorBody,
          429: errorBody,
          503: errorBody,
        },
      },
    },
    async () => ({ flags: await deps.flags.list() }),
  );
}
