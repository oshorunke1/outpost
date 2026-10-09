// A tiny game-server simulator. It drives the same HTTP contract the Roblox BackendClient uses, so
// a reviewer without Studio can watch the whole flow and then find it as traces in Jaeger.
// Run `pnpm demo` from the repo root after `docker compose up -d --build --wait`.
// Settings: OUTPOST_BACKEND_URL (default http://127.0.0.1:3000), OUTPOST_GAME_API_KEY (from the root
// .env), OUTPOST_DEMO_USER_ID (optional, a random player per run otherwise) and OUTPOST_JAEGER_URL
// (optional, default http://localhost:16686, only used for the closing hint). The flow lives in
// demoFlow.ts, where the unit tests drive it.
// Each run trades the key for a token once, and the backend allows about 30 of those a minute per
// game client, so a tight loop of more runs than that gets a 429 on the first step.
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { mainDemo } from './demoFlow.js';

const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));

process.exitCode = await mainDemo(process.env, {
  fetch: (url, init) => fetch(url, init),
  sleep: (ms) => sleep(ms),
  now: () => Date.now(),
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  // loadEnvFile never overrides a variable that is already set, so an exported key wins over .env.
  loadEnv: () => {
    if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
  },
});
