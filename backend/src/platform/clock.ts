// Everything that needs the time takes a Clock, so tests can move time forward without waiting.
export interface Clock {
  now(): number; // epoch milliseconds
}

export const systemClock: Clock = { now: () => Date.now() };
