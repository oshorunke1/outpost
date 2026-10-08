import { z } from 'zod';
import type { Clock } from '../../platform/clock.js';
import { AppError } from '../../platform/errors.js';
import { errorBody } from '../../platform/http.js';
import type { ZodApp } from '../../platform/http.js';
import { requireService } from '../identity/guards.js';
import type { GuardFor } from '../identity/guards.js';
import type { TelemetryProducer } from './producer.js';
import { splitByClock, telemetryBatchSchema } from './schema.js';

// A full batch of 500 events is far over the 16 KiB app wide limit, so this route has its own.
export const TELEMETRY_BODY_LIMIT_BYTES = 512 * 1024;

export interface TelemetryRouteDeps {
  telemetry: TelemetryProducer;
  clock: Clock;
  guardFor: GuardFor;
}

export function registerTelemetryRoutes(app: ZodApp, deps: TelemetryRouteDeps): void {
  app.post(
    '/v1/telemetry/batch',
    {
      // Its own bucket group, so a telemetry flood never spends the bucket purchases need.
      onRequest: deps.guardFor('game:telemetry', 'telemetry'),
      bodyLimit: TELEMETRY_BODY_LIMIT_BYTES,
      schema: {
        tags: ['telemetry'],
        summary: 'Queue up to 500 gameplay and health events. Answers before any database work.',
        security: [{ bearer: [] }],
        body: telemetryBatchSchema,
        response: {
          202: z.object({ accepted: z.number().int(), dropped: z.number().int() }),
          400: errorBody,
          401: errorBody,
          403: errorBody,
          413: errorBody,
          429: errorBody,
          503: errorBody,
        },
      },
    },
    async (request, reply) => {
      const principal = requireService(request);
      const { kept, dropped } = splitByClock(request.body.events, deps.clock.now());
      try {
        if (kept.length > 0) await deps.telemetry.publish(principal.clientId, kept);
      } catch (error) {
        // The game treats telemetry as fail open and drops the batch; the API just says so.
        throw new AppError(503, 'telemetry_unavailable', 'Telemetry is temporarily unavailable', { cause: error });
      }
      return reply.code(202).send({ accepted: kept.length, dropped });
    },
  );
}
