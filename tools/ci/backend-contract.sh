#!/usr/bin/env bash
# The game-backend-contract CI job, as one script so it runs the same way on a Linux laptop.
# It needs bash 4 or newer and real POSIX signals, so it does not run under Git Bash on Windows
# (SIGTERM does not reach node there) or the stock bash 3.2 on macOS (no mapfile -d).
# It migrates and seeds the database, boots the built backend with the exact command its Docker image
# runs (the Dockerfile CMD, read by tools/dockerfile-cmd.mjs, never through pnpm), waits for /readyz,
# runs the game-server simulator (pnpm demo), then runs the Lune contract suite CONTRACT_RUNS times in a
# row (default 2, so a rerun against the same database is proven too). Last it sends SIGTERM and insists
# on a clean exit 0.
# Needs DATABASE_URL (the database must exist), REDIS_URL, PORT, NODE_ENV (test or development, the
# seed refuses anything else) and OUTPOST_GAME_API_KEY (a throwaway key, its hash is seeded). Run it from
# the repo root after a backend build, with lune on the PATH. The key is never printed.
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL}"
: "${REDIS_URL:?set REDIS_URL}"
: "${PORT:?set PORT}"
: "${NODE_ENV:?set NODE_ENV to test}"
: "${OUTPOST_GAME_API_KEY:?set OUTPOST_GAME_API_KEY}"
READY_TIMEOUT_SECONDS="${READY_TIMEOUT_SECONDS:-30}"
STOP_TIMEOUT_SECONDS="${STOP_TIMEOUT_SECONDS:-30}"
CONTRACT_RUNS="${CONTRACT_RUNS:-2}"
case "$CONTRACT_RUNS" in
  "" | *[!0-9]* | 0) echo "CONTRACT_RUNS must be a whole number of at least 1" >&2; exit 1 ;;
esac
export PATH="$HOME/.rokit/bin:$PATH"
export OUTPOST_BACKEND_URL="http://127.0.0.1:${PORT}"
LOG_FILE="$(mktemp)"
CMD_FILE="$(mktemp)"
SERVER_PID=""

# Runs on every exit, failed or not: the server never outlives the script, and a failure shows its log.
cleanup() {
  local status=$?
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -KILL "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ "$status" -ne 0 ]; then
    echo "--- server log"
    cat "$LOG_FILE"
  fi
  rm -f "$LOG_FILE" "$CMD_FILE"
  exit "$status"
}
trap cleanup EXIT

fail() {
  echo "$1"
  exit 1
}

node backend/dist/cli/migrate.js
node backend/dist/cli/seed.js

node tools/dockerfile-cmd.mjs backend/Dockerfile >"$CMD_FILE"
mapfile -d '' CMD <"$CMD_FILE"
[ "${#CMD[@]}" -gt 0 ] || fail "backend/Dockerfile gave no CMD"
echo "starting: ${CMD[*]}"

# The image's WORKDIR is backend/, so the CMD's relative paths resolve from there.
cd backend
"${CMD[@]}" >"$LOG_FILE" 2>&1 &
SERVER_PID=$!
cd ..

ready=false
for _ in $(seq 1 "$READY_TIMEOUT_SECONDS"); do
  kill -0 "$SERVER_PID" 2>/dev/null || fail "the server exited before it was ready"
  if curl --silent --fail --max-time 2 "${OUTPOST_BACKEND_URL}/readyz" >/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
[ "$ready" = true ] || fail "/readyz was not ready within ${READY_TIMEOUT_SECONDS}s"
echo "/readyz is ready"

echo "--- game server simulator"
npx --yes pnpm@10.34.6 demo

for run in $(seq 1 "$CONTRACT_RUNS"); do
  echo "--- Lune contract suite, run ${run} of ${CONTRACT_RUNS}"
  (cd game && lune run tests/Contract/Run)
done

kill -TERM "$SERVER_PID"

# The watchdog: give the server STOP_TIMEOUT_SECONDS to drain, then the trap kills it and the script fails.
for _ in $(seq 1 "$STOP_TIMEOUT_SECONDS"); do
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 1
done
kill -0 "$SERVER_PID" 2>/dev/null && fail "the server was still running ${STOP_TIMEOUT_SECONDS}s after SIGTERM"

status=0
wait "$SERVER_PID" || status=$?
SERVER_PID=""
[ "$status" -eq 0 ] || fail "the server exited with $status after SIGTERM, expected 0"
echo "the server stopped cleanly on SIGTERM"
