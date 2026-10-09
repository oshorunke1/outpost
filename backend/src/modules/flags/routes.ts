import { z } from 'zod';
import { errorBody } from '../../platform/http.js';
import type { ZodApp } from '../../platform/http.js';
import { named } from '../../platform/schemas.js';
import type { GuardFor } from '../identity/guards.js';
import type { FlagsService } from './flagsService.js';

const flagValues = named('Flags', z.object({ flags: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])) }));

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
        operationId: 'listFlags',
        summary: 'Current flag values. The game keeps its last known values if this fails.',
        security: [{ bearer: [] }],
        // The flags service's 503 says when to retry. The guard's 503 does not.
        'x-response-headers': { 503: { 'retry-after': 'sometimes' } },
        response: {
          200: flagValues,
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
