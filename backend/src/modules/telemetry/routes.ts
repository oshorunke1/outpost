import { z } from 'zod';
import type { Clock } from '../../platform/clock.js';
import { AppError, summarizeCause } from '../../platform/errors.js';
import { errorBody } from '../../platform/http.js';
import type { ZodApp } from '../../platform/http.js';
import type { Metrics } from '../../platform/metrics.js';
import { requireService } from '../identity/guards.js';
import type { FlagsService } from '../flags/flagsService.js';
import type { GuardFor } from '../identity/guards.js';
import type { TelemetryProducer } from './producer.js';
import { splitByClock, telemetryBatchSchema } from './schema.js';

// A full batch of 500 events is far over the 16 KiB app wide limit, so this route has its own.
export const TELEMETRY_BODY_LIMIT_BYTES = 512 * 1024;

export interface TelemetryRouteDeps {
  telemetry: TelemetryProducer;
  clock: Clock;
  flags: FlagsService;
  metrics: Metrics;
  guardFor: GuardFor;
}

// TelemetryEnabled off means every event is dropped. If flags cannot be read at all, telemetry
// fails open and stays on, because losing the flag must not also lose the data.
// The lookup is bounded too, so a slow MySQL never holds a batch for long.
export const TELEMETRY_FLAGS_TIMEOUT_MS = 250;

async function telemetryEnabled(deps: TelemetryRouteDeps, log: { warn(details: object, message: string): void }): Promise<boolean> {
  const lookup = deps.flags.list();
  lookup.catch(() => undefined); // a lookup that fails after the bound must not go unhandled
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), TELEMETRY_FLAGS_TIMEOUT_MS);
  });
  try {
    const flags = await Promise.race([lookup, late]);
    if (flags === 'late') {
      log.warn({ timeoutMs: TELEMETRY_FLAGS_TIMEOUT_MS }, 'flags lookup took too long; telemetry stays on');
      return true;
    }
    return flags.TelemetryEnabled !== false;
  } catch (error) {
    log.warn({ cause: summarizeCause(error) }, 'flags unavailable; telemetry stays on');
    return true;
  } finally {
    clearTimeout(timer);
  }
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
      if (!(await telemetryEnabled(deps, request.log))) {
        deps.metrics.telemetryDropped.inc({ reason: 'disabled' }, request.body.events.length);
        return reply.code(202).send({ accepted: 0, dropped: request.body.events.length });
      }
      const { kept, dropped } = splitByClock(request.body.events, deps.clock.now());
      try {
        if (kept.length > 0) await deps.telemetry.publish(principal.clientId, kept);
      } catch (error) {
        // Counted once here; the skewed ones are counted by whichever attempt succeeds.
        deps.metrics.telemetryDropped.inc({ reason: 'unavailable' }, kept.length);
        // The game treats telemetry as fail open and drops the batch; the API just says so.
        throw new AppError(503, 'telemetry_unavailable', 'Telemetry is temporarily unavailable', { cause: error });
      }
      deps.metrics.telemetryAccepted.inc(kept.length);
      deps.metrics.telemetryDropped.inc({ reason: 'clock_skew' }, dropped);
      return reply.code(202).send({ accepted: kept.length, dropped });
    },
  );
}
