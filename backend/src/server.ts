// The API entry point: `node dist/server.js` (npm start adds OpenTelemetry with --import).
// The signal hook goes in first, before the app and its dependencies load (which takes a while),
// so a SIGTERM during startup stops it cleanly. Everything else lives in serverMain.ts.
import { processStopSignal } from './platform/lifecycle.js';

// Already installed by the dist/signals.js preload when started through Docker or npm start.
const stop = processStopSignal();

try {
  const { runServer } = await import('./serverMain.js');
  await runServer(stop);
} catch (error) {
  // ConfigError, pingDb and connectRedis messages name what failed but never print a URL or secret.
  console.error(error);
  process.exit(1);
}
