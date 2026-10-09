import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'vitest';
import { onShutdownSignal, serverShutdownSteps, shutdownInOrder, workerShutdownSteps } from '../../../src/platform/lifecycle.js';

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
});
