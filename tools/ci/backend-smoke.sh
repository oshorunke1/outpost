#!/usr/bin/env bash
# Boots the built backend with its real start script (the signals and OpenTelemetry preloads),
# waits for /readyz, then stops it with SIGTERM and insists on a clean exit 0.
# Needs DATABASE_URL (its database is created if missing) and REDIS_URL, run from the repo root after a build.
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL}"
: "${REDIS_URL:?set REDIS_URL}"
PORT="${PORT:-3000}"
READY_TIMEOUT_SECONDS="${READY_TIMEOUT_SECONDS:-30}"
LOG_FILE="$(mktemp)"

# The smoke database starts empty, so create it and apply the migrations from the built output.
(cd backend && node --input-type=module -e "
import mysql from 'mysql2/promise';
const url = new URL(process.env.DATABASE_URL);
const name = decodeURIComponent(url.pathname.slice(1));
url.pathname = '/';
const conn = await mysql.createConnection(url.toString());
await conn.query('CREATE DATABASE IF NOT EXISTS ??', [name]);
await conn.end();
")
node backend/dist/cli/migrate.js

# The real start script, in its own process group so a failed run can clean up everything under it.
setsid pnpm --filter @outpost/backend start >"$LOG_FILE" 2>&1 &
SERVER_PID=$!

# pnpm runs the script through sh -c. On SIGTERM pnpm signals that sh, which dies without passing the
# signal on, so node would never see it. A container stop signals node directly (the Dockerfile CMD
# runs node as the main process), so this signals the node server itself, the same way.
node_pid() {
  pgrep -g "$SERVER_PID" -f '^node .*dist/server\.js' | head -n 1
}

kill_all() {
  kill -KILL -- "-$SERVER_PID" 2>/dev/null || true
}

fail() {
  echo "$1"
  kill_all
  wait "$SERVER_PID" 2>/dev/null || true
  cat "$LOG_FILE"
  exit 1
}

ready=false
for _ in $(seq 1 "$READY_TIMEOUT_SECONDS"); do
  kill -0 "$SERVER_PID" 2>/dev/null || fail "the server exited before it was ready"
  if curl --silent --fail --max-time 2 "http://127.0.0.1:${PORT}/readyz" >/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
[ "$ready" = true ] || fail "/readyz was not ready within ${READY_TIMEOUT_SECONDS}s"
echo "/readyz is ready: $(curl --silent "http://127.0.0.1:${PORT}/readyz")"

NODE_PID="$(node_pid)"
[ -n "$NODE_PID" ] || fail "could not find the node server under pnpm"
kill -TERM "$NODE_PID"

# sh and pnpm pass the server's own exit code up, so 0 here means node shut down cleanly on SIGTERM.
status=0
wait "$SERVER_PID" || status=$?
cat "$LOG_FILE"
[ "$status" -eq 0 ] || fail "the server exited with $status after SIGTERM, expected 0"
echo "the server stopped cleanly on SIGTERM"
