import type { Clock } from '../../src/platform/clock.js';

export interface FakeClock extends Clock {
  advance(ms: number): void;
  set(ms: number): void;
}

// Starts on a whole minute so window and bucket maths in tests is easy to follow.
export function createFakeClock(startMs = Date.UTC(2026, 9, 8, 12, 0, 0)): FakeClock {
  let current = startMs;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
    set(ms) {
      current = ms;
    },
  };
}
