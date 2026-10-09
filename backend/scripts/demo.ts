// A tiny game-server simulator. It drives the same HTTP contract the Roblox BackendClient uses, so
// a reviewer without Studio can watch the whole flow and then find it as traces in Jaeger.
// Run `pnpm demo` from the repo root after `docker compose up -d --build --wait`.
// Settings: OUTPOST_BACKEND_URL (default http://127.0.0.1:3000), OUTPOST_GAME_API_KEY (from the root
// .env) and OUTPOST_DEMO_USER_ID (optional, a random player per run otherwise). The flow lives in
// demoFlow.ts, where the unit tests drive it.
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { mainDemo } from './demoFlow.js';

// loadEnvFile never overrides a variable that is already set, so an exported key wins over .env.
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

process.exitCode = await mainDemo(process.env, {
  fetch: (url, init) => fetch(url, init),
  sleep: (ms) => sleep(ms),
  now: () => Date.now(),
  log: (line) => console.log(line),
  error: (line) => console.error(line),
});
