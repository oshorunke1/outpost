import type { Redis } from '../../platform/redis.js';
import type { TelemetryEvent } from './schema.js';

export const STREAM_KEY = 'telemetry:events';
// Approximate trim (MAXLEN ~) keeps the stream bounded in memory even if the worker stops.
export const STREAM_MAX_LEN = 1_000_000;

export interface TelemetryProducer {
  publish(source: string, events: readonly TelemetryEvent[]): Promise<void>;
}

export interface MemoryTelemetryProducer extends TelemetryProducer {
  published: { source: string; event: TelemetryEvent }[];
}

export function createMemoryTelemetryProducer(): MemoryTelemetryProducer {
  const published: { source: string; event: TelemetryEvent }[] = [];
  return {
    published,
    async publish(source, events) {
      for (const event of events) published.push({ source, event });
    },
  };
}

// One XADD per event, sent in a single pipeline round trip. Each entry has two fields, e (the event
// as JSON) and s (the client id that sent it, taken from the token and never from the body).
export function createRedisTelemetryProducer(redis: Redis): TelemetryProducer {
  return {
    async publish(source, events) {
      if (events.length === 0) return;
      const pipeline = redis.pipeline();
      for (const event of events) {
        pipeline.xadd(STREAM_KEY, 'MAXLEN', '~', STREAM_MAX_LEN, '*', 'e', JSON.stringify(event), 's', source);
      }
      const results = await pipeline.exec();
      if (!results) throw new Error('the telemetry pipeline was aborted');
      for (const [error] of results) if (error) throw error;
    },
  };
}
