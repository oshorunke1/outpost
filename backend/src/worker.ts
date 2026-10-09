// The telemetry worker entry point: `node dist/worker.js` (npm run start:worker adds OpenTelemetry).
// Like server.ts, the signal hook goes in before anything else loads. The rest is in workerMain.ts.
import { processStopSignal } from './platform/lifecycle.js';

// Already installed by the dist/signals.js preload when started through Docker or npm start.
const stop = processStopSignal();

try {
  const { runWorker } = await import('./workerMain.js');
  await runWorker(stop);
} catch (error) {
  console.error(error);
  process.exit(1);
}
