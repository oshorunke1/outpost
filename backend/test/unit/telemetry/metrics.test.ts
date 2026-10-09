import { describe, expect, test } from 'vitest';
import { buildApp } from '../../../src/app.js';
import { createMemoryAppDeps } from '../../../src/memoryDeps.js';
import { FLAG_DEFAULTS, createMemoryFlagsService } from '../../../src/modules/flags/flagsService.js';
import type { TelemetryProducer } from '../../../src/modules/telemetry/producer.js';
import { createFakeClock } from '../../support/clock.js';
import { counterValue } from '../../support/metrics.js';
import { bearer, gameToken } from '../../support/tokens.js';

const clock = createFakeClock();

async function post(overrides: Parameters<typeof createMemoryAppDeps>[0] = {}, events: unknown[] = []) {
  const memory = await createMemoryAppDeps({ clock, ...overrides });
  const app = await buildApp(memory.deps);
  const response = await app.inject({
    method: 'POST',
    url: '/v1/telemetry/batch',
    headers: bearer(await gameToken(memory.deps.tokens)),
    payload: { events },
  });
  return { response, metrics: memory.deps.metrics };
}

const fresh = () => ({ name: 'orb_collected', ts: clock.now() });
const skewed = () => ({ name: 'orb_collected', ts: clock.now() + 3_600_000 });

describe('telemetry counters', () => {
  test('accepted counts the queued events and dropped counts clock skew', async () => {
    const { response, metrics } = await post({}, [fresh(), fresh(), fresh(), skewed()]);
    expect(response.json()).toEqual({ accepted: 3, dropped: 1 });
    expect(await counterValue(metrics.telemetryAccepted)).toBe(3);
    expect(await counterValue(metrics.telemetryDropped, { reason: 'clock_skew' })).toBe(1);
    expect(await counterValue(metrics.telemetryDropped, { reason: 'disabled' })).toBe(0);
  });

  test('with TelemetryEnabled off every event counts as dropped for the disabled reason', async () => {
    const flags = createMemoryFlagsService({ ...FLAG_DEFAULTS, TelemetryEnabled: false });
    const { response, metrics } = await post({ overrides: { flags } }, [fresh(), fresh()]);
    expect(response.json()).toEqual({ accepted: 0, dropped: 2 });
    expect(await counterValue(metrics.telemetryAccepted)).toBe(0);
    expect(await counterValue(metrics.telemetryDropped, { reason: 'disabled' })).toBe(2);
  });

  test('a batch the stream refused is not counted as accepted', async () => {
    const telemetry: TelemetryProducer = { publish: async () => Promise.reject(new Error('redis down')) };
    const { response, metrics } = await post({ overrides: { telemetry } }, [fresh()]);
    expect(response.statusCode).toBe(503);
    expect(await counterValue(metrics.telemetryAccepted)).toBe(0);
  });
});
