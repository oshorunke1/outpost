// Start and stop helpers shared by the two entry points (server.ts and worker.ts). They only take
// the small shapes they call, so tests drive them with plain fakes.

export interface ShutdownStep {
  name: string;
  run(): unknown; // awaited, so a promise is waited for
}

export interface ShutdownLogger {
  error(details: object, message: string): void;
}

interface Closable {
  close(done: (error?: Error) => void): unknown;
}

export interface WorkerResources {
  metricsServer: Closable;
  redis: { quit(): Promise<unknown> };
  db: { end(): Promise<void> };
}

export interface ServerResources extends WorkerResources {
  health: { setDraining(): void };
  app: { close(): Promise<unknown> };
}

function closeServer(server: Closable): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function errorFields(error: unknown): { err: string; code?: string } {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return { err: error instanceof Error ? error.message : String(error), ...(typeof code === 'string' ? { code } : {}) };
}

// Readiness says draining first, so the load balancer stops sending new requests, then Fastify
// finishes the requests it already has. The clients close last, once nothing can use them.
export function serverShutdownSteps(resources: ServerResources): ShutdownStep[] {
  return [
    { name: 'draining', run: () => resources.health.setDraining() },
    { name: 'app', run: () => resources.app.close() },
    ...workerShutdownSteps(resources),
  ];
}

// The worker's loop has already stopped (after its current batch) when these run.
export function workerShutdownSteps(resources: WorkerResources): ShutdownStep[] {
  return [
    { name: 'metrics server', run: () => closeServer(resources.metricsServer) },
    { name: 'redis', run: () => resources.redis.quit() },
    { name: 'mysql pool', run: () => resources.db.end() },
  ];
}

// Every step runs, even after one fails, so a stuck Redis never leaves the pool open. Returns the
// exit code: 0 when every step worked, 1 otherwise.
export async function shutdownInOrder(steps: readonly ShutdownStep[], logger: ShutdownLogger): Promise<number> {
  let code = 0;
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      code = 1;
      logger.error({ step: step.name, ...errorFields(error) }, 'shutdown step failed');
    }
  }
  return code;
}

interface SignalSource {
  on(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
}

// The first SIGTERM or SIGINT runs the handler. Any signal after that is ignored, so a second
// Ctrl+C never starts a second shutdown on top of the first.
export function onShutdownSignal(handler: (signal: 'SIGTERM' | 'SIGINT') => unknown, source: SignalSource = process): void {
  let started = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    source.on(signal, () => {
      if (started) return;
      started = true;
      void handler(signal);
    });
  }
}

// Process exits and timers, injected in tests so nothing really exits or waits.
export interface ExitDeps {
  exit(code: number): void;
  setExitCode(code: number): void;
  setTimer(callback: () => void, ms: number): { unref(): unknown };
}

const processExitDeps: ExitDeps = {
  exit: (code) => process.exit(code),
  setExitCode: (code) => {
    process.exitCode = code;
  },
  setTimer: (callback, ms) => setTimeout(callback, ms),
};

// The whole shutdown, from the signal to the last step, gets this long. Compose gives the backend
// and the worker a stop_grace_period of 15 s, so this deadline fires (and logs) before Docker's SIGKILL.
export const SHUTDOWN_DEADLINE_MS = 10_000;

// Armed when the signal arrives. If shutdown has not finished by then (a request that never ends,
// a hung batch), it logs and exits 1. The timer is unref'd, so a clean shutdown never waits on it.
export function armShutdownDeadline(logger: ShutdownLogger, deadlineMs = SHUTDOWN_DEADLINE_MS, deps: Partial<ExitDeps> = {}): void {
  const { exit, setTimer } = { ...processExitDeps, ...deps };
  setTimer(() => {
    logger.error({ deadlineMs }, 'shutdown did not finish within the deadline, exiting');
    exit(1);
  }, deadlineMs).unref();
}

// Sets the exit code and lets the event loop drain instead of cutting it off. If something still
// holds the loop open, the process exits anyway after graceMs (an unref'd timer, so it never delays
// a clean exit).
//
// Tracing: the OpenTelemetry register (--import .../register) adds its own SIGTERM listener that
// shuts the SDK down the moment the signal arrives, in parallel with this ordered shutdown, and it
// has no switch to turn that off. So on SIGTERM the spans of the drain itself (requests that finish
// inside app.close, the worker's last batch) are dropped. On SIGINT and on a normal exit the SDK
// shuts down through beforeExit, after the drain, and those spans are kept.
export function exitWhenDrained(code: number, graceMs = 5_000, deps: Partial<ExitDeps> = {}): void {
  const { exit, setExitCode, setTimer } = { ...processExitDeps, ...deps };
  setExitCode(code);
  setTimer(() => exit(code), graceMs).unref();
}

// Thrown by Startup.open once a stop signal has arrived, so main stops starting things up.
export class StartupAborted extends Error {
  constructor() {
    super('a stop signal arrived during startup');
    this.name = 'StartupAborted';
  }
}

export interface Startup {
  // Runs create, remembers close for it, then checks the signal. A signal that arrived before or
  // during create throws StartupAborted (after recording close, so the new resource is still closed).
  open<T>(name: string, create: () => Promise<T> | T, close?: (resource: T) => unknown): Promise<T>;
  // Close steps for everything opened, newest first.
  closeSteps(): ShutdownStep[];
}

// The entry points install the signal hook before any startup work. A SIGTERM during startup (the
// container is stopped while MySQL is still connecting) then stops after the step in flight and
// closes only what was opened, instead of being lost while the process starts serving anyway.
export function createStartup(signal: AbortSignal): Startup {
  const steps: ShutdownStep[] = [];
  return {
    async open(name, create, close) {
      if (signal.aborted) throw new StartupAborted();
      const resource = await create();
      if (close) steps.unshift({ name, run: () => close(resource) });
      if (signal.aborted) throw new StartupAborted();
      return resource;
    },
    closeSteps: () => [...steps],
  };
}
