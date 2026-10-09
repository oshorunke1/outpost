// Start and stop helpers shared by the two entry points (server.ts and worker.ts). They only take
// the small shapes they call, so tests drive them with plain fakes.

export interface ShutdownStep {
  name: string;
  run(): Promise<unknown> | void;
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

// Sets the exit code and lets the event loop drain, so the tracing SDK can flush its last spans.
// If something still holds the loop open, the process exits anyway after graceMs.
export function exitWhenDrained(code: number, graceMs = 5_000): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), graceMs).unref();
}
