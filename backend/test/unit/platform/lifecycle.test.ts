import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, test } from 'vitest';
import {
  SHUTDOWN_DEADLINE_MS,
  StartupAborted,
  armShutdownDeadline,
  createStartup,
  exitWhenDrained,
  onShutdownSignal,
  onStop,
  processStopSignal,
  serverShutdownSteps,
  shutdownInOrder,
  workerShutdownSteps,
} from '../../../src/platform/lifecycle.js';

const recordingLogger = () => {
  const errors: { details: Record<string, unknown>; message: string }[] = [];
  return { errors, logger: { error: (details: object, message: string) => void errors.push({ details: details as Record<string, unknown>, message }) } };
};

// Records the order each resource is touched in, standing in for the real app, servers and clients.
function fakeResources(calls: string[]) {
  return {
    health: { setDraining: () => void calls.push('draining') },
    app: { close: async () => void calls.push('app') },
    metricsServer: {
      close: (done: (error?: Error) => void) => {
        calls.push('metrics');
        done();
      },
    },
    redis: {
      quit: async (): Promise<unknown> => {
        calls.push('redis');
        return 'OK';
      },
    },
    db: { end: async () => void calls.push('db') },
  };
}

describe('lifecycle', () => {
  test('the server drains readiness before closing the app, then the metrics server, Redis and the pool', async () => {
    const calls: string[] = [];
    const { logger } = recordingLogger();
    const code = await shutdownInOrder(serverShutdownSteps(fakeResources(calls)), logger);
    expect(calls).toEqual(['draining', 'app', 'metrics', 'redis', 'db']);
    expect(code).toBe(0);
  });

  test('the worker closes the metrics server, Redis and the pool, in that order', async () => {
    const calls: string[] = [];
    const { logger } = recordingLogger();
    expect(await shutdownInOrder(workerShutdownSteps(fakeResources(calls)), logger)).toBe(0);
    expect(calls).toEqual(['metrics', 'redis', 'db']);
  });

  test('a failing step is logged by name, the later steps still run, and the exit code is 1', async () => {
    const calls: string[] = [];
    const resources = fakeResources(calls);
    resources.redis.quit = async () => {
      calls.push('redis');
      throw Object.assign(new Error('Connection is closed.'), { code: 'ECONNRESET' });
    };
    const { errors, logger } = recordingLogger();
    expect(await shutdownInOrder(serverShutdownSteps(resources), logger)).toBe(1);
    expect(calls).toEqual(['draining', 'app', 'metrics', 'redis', 'db']);
    expect(errors).toEqual([{ details: { step: 'redis', err: 'Connection is closed.', code: 'ECONNRESET' }, message: 'shutdown step failed' }]);
  });

  test('a metrics server close error fails its step', async () => {
    const calls: string[] = [];
    const resources = fakeResources(calls);
    resources.metricsServer.close = (done) => done(new Error('Server is not running.'));
    const { errors, logger } = recordingLogger();
    expect(await shutdownInOrder(workerShutdownSteps(resources), logger)).toBe(1);
    expect(errors.map((line) => line.details.step)).toEqual(['metrics server']);
  });

  test('SIGTERM or SIGINT runs the handler once, however many signals arrive', () => {
    const proc = new EventEmitter();
    const seen: string[] = [];
    onShutdownSignal((signal) => void seen.push(signal), proc);
    proc.emit('SIGTERM');
    proc.emit('SIGINT');
    proc.emit('SIGTERM');
    expect(seen).toEqual(['SIGTERM']);

    const other = new EventEmitter();
    const seenOther: string[] = [];
    onShutdownSignal((signal) => void seenOther.push(signal), other);
    other.emit('SIGINT');
    expect(seenOther).toEqual(['SIGINT']);
  });

  // R-a: a stuck step (a request that never finishes, a hung batch) must not keep the process up
  // until Docker's SIGKILL. The deadline logs and exits 1 first.
  test('a hanging close hits the deadline, which logs and exits 1', async () => {
    expect(SHUTDOWN_DEADLINE_MS).toBe(10_000);
    const calls: string[] = [];
    const resources = fakeResources(calls);
    resources.app.close = () => new Promise<undefined>(() => undefined);
    const { errors, logger } = recordingLogger();
    const exits: number[] = [];
    armShutdownDeadline(logger, 30, { exit: (code) => void exits.push(code) });
    void shutdownInOrder(serverShutdownSteps(resources), logger);
    await sleep(80);
    expect(calls).toEqual(['draining']);
    expect(exits).toEqual([1]);
    expect(errors).toEqual([{ details: { deadlineMs: 30 }, message: 'shutdown did not finish within the deadline, exiting' }]);
  });

  test('the deadline timer never holds a clean exit open', () => {
    const timers: { ms: number; unrefed: boolean }[] = [];
    const setTimer = (_callback: () => void, ms: number) => {
      const timer = { ms, unrefed: false, unref: () => (timer.unrefed = true) };
      timers.push(timer);
      return timer;
    };
    armShutdownDeadline(recordingLogger().logger, undefined, { setTimer, exit: () => undefined });
    expect(timers.map(({ ms, unrefed }) => ({ ms, unrefed }))).toEqual([{ ms: SHUTDOWN_DEADLINE_MS, unrefed: true }]);
  });

  // M5: the exit code is set at once and the loop drains; the fallback exit is unref'd, so it
  // only fires when something still holds the loop open.
  test('exitWhenDrained sets the exit code and arms an unref fallback exit', () => {
    const codes: number[] = [];
    const exits: number[] = [];
    let fire: () => void = () => undefined;
    const timers: { ms: number; unrefed: boolean }[] = [];
    exitWhenDrained(0, 5_000, {
      setExitCode: (code) => void codes.push(code),
      exit: (code) => void exits.push(code),
      setTimer: (callback, ms) => {
        fire = callback;
        const timer = { ms, unrefed: false, unref: () => (timer.unrefed = true) };
        timers.push(timer);
        return timer;
      },
    });
    expect(codes).toEqual([0]);
    expect(exits).toEqual([]);
    expect(timers.map(({ ms, unrefed }) => ({ ms, unrefed }))).toEqual([{ ms: 5_000, unrefed: true }]);
    fire();
    expect(exits).toEqual([0]);
  });

  // M1: the signal hook goes in before any startup work. A signal during startup stops it after
  // the step in flight, and only what was opened gets closed, newest first.
  test('a signal during startup stops after the current step and closes what was opened, newest first', async () => {
    const controller = new AbortController();
    const startup = createStartup(controller.signal);
    const log: string[] = [];
    await startup.open('mysql pool', async () => log.push('open mysql'), () => void log.push('close mysql'));
    await expect(
      startup.open('redis', async () => {
        controller.abort(); // SIGTERM lands while Redis connects
        log.push('open redis');
      }, () => void log.push('close redis')),
    ).rejects.toBeInstanceOf(StartupAborted);
    await expect(startup.open('metrics server', async () => log.push('open metrics'))).rejects.toBeInstanceOf(StartupAborted);
    const { logger } = recordingLogger();
    expect(await shutdownInOrder(startup.closeSteps(), logger)).toBe(0);
    expect(log).toEqual(['open mysql', 'open redis', 'close redis', 'close mysql']);
  });

  test('without a signal, startup opens everything and hands back each resource', async () => {
    const startup = createStartup(new AbortController().signal);
    expect(await startup.open('a', () => 41)).toBe(41);
    expect(await startup.open('b', async () => 'two')).toBe('two');
    expect(startup.closeSteps().map((step) => step.name)).toEqual([]);
  });

  test('onStop runs once on abort, or at once when the signal already aborted while loading', () => {
    const later = new AbortController();
    const seen: string[] = [];
    onStop(later.signal, () => seen.push('later'));
    expect(seen).toEqual([]);
    later.abort('SIGTERM');
    later.abort('SIGINT');
    expect(seen).toEqual(['later']);

    const early = new AbortController();
    early.abort('SIGTERM');
    onStop(early.signal, () => seen.push('early'));
    expect(seen).toEqual(['later', 'early']);
  });

  // The preload (dist/signals.js, loaded with --import before OpenTelemetry) and the entry file
  // share one stop signal, so the hook goes in once, as early as the process allows.
  test('processStopSignal installs one hook per process and hands every caller the same signal', () => {
    const proc = new EventEmitter();
    const first = processStopSignal(proc);
    const second = processStopSignal(proc);
    expect(second).toBe(first);
    expect(proc.listenerCount('SIGTERM')).toBe(1);
    proc.emit('SIGTERM');
    expect(first.aborted).toBe(true);
    expect(first.reason).toBe('SIGTERM');
  });
});
