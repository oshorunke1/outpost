#!/usr/bin/env bash
# Boots the built backend with the exact command its Docker image runs (the Dockerfile CMD, read by
# tools/dockerfile-cmd.mjs so the two never drift), waits for /readyz, then sends it SIGTERM and
# insists on a clean exit 0. No pnpm in between, because pnpm does not pass SIGTERM on to node.
# Needs DATABASE_URL (its database is created if missing), REDIS_URL and PORT. Run it from the repo
# root after a build. With NODE_ENV=production and no JWT_PRIVATE_KEY_PEM, it makes a throwaway key.
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL}"
: "${REDIS_URL:?set REDIS_URL}"
: "${PORT:?set PORT}"
READY_TIMEOUT_SECONDS="${READY_TIMEOUT_SECONDS:-30}"
STOP_TIMEOUT_SECONDS="${STOP_TIMEOUT_SECONDS:-30}"
LOG_FILE="$(mktemp)"
CMD_FILE="$(mktemp)"
SERVER_PID=""
LOG_PRINTED=false

print_log_once() {
  if [ "$LOG_PRINTED" = false ]; then
    LOG_PRINTED=true
    echo "--- server log"
    cat "$LOG_FILE"
  fi
}

# Runs on every exit, failed or not: the server never outlives the script and its log shows up once.
cleanup() {
  local status=$?
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -KILL "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  print_log_once
  rm -f "$LOG_FILE" "$CMD_FILE"
  exit "$status"
}
trap cleanup EXIT

fail() {
  echo "$1"
  exit 1
}

# Production refuses to start without a signing key. This one lives only in this step's environment
# and is never printed.
if [ "${NODE_ENV:-}" = production ] && [ -z "${JWT_PRIVATE_KEY_PEM:-}" ]; then
  JWT_PRIVATE_KEY_PEM="$(node -e "
const { generateKeyPairSync } = require('node:crypto');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
process.stdout.write(privateKey.export({ type: 'pkcs8', format: 'pem' }));
")"
  export JWT_PRIVATE_KEY_PEM
fi

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
  if curl --silent --fail --max-time 2 "http://127.0.0.1:${PORT}/readyz" >/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
[ "$ready" = true ] || fail "/readyz was not ready within ${READY_TIMEOUT_SECONDS}s"
echo "/readyz is ready: $(curl --silent "http://127.0.0.1:${PORT}/readyz")"

kill -TERM "$SERVER_PID"

# The watchdog: give the server STOP_TIMEOUT_SECONDS to drain, then the trap kills it and the step fails.
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
