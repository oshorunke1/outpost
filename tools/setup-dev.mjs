#!/usr/bin/env node
// Writes a git-ignored .env with fresh random dev secrets, so no secret is ever committed.
// Run it from the repo root with pnpm setup:dev. It never overwrites an existing .env.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function randomSecret(bytes = 24) {
  return randomBytes(bytes).toString("base64url");
}

// Fills only lines that look like NAME= with nothing after the equals sign.
export function renderEnv(template, secrets) {
  return template.replace(/^([A-Z0-9_]+)=$/gm, (line, name) => (name in secrets ? `${name}=${secrets[name]}` : line));
}

export function makeSecrets() {
  const rootPassword = randomSecret();
  return {
    MYSQL_ROOT_PASSWORD: rootPassword,
    MYSQL_APP_PASSWORD: randomSecret(),
    OUTPOST_GAME_API_KEY: `opk_game-server.${randomSecret(32)}`,
    OUTPOST_DEV_OPERATOR_PASSWORD: randomSecret(),
    TEST_MYSQL_URL: `mysql://root:${rootPassword}@127.0.0.1:3306`,
  };
}

export function setupDev({ repoRoot, secrets = makeSecrets() }) {
  const target = resolve(repoRoot, ".env");
  if (existsSync(target)) return { written: false, path: target };
  const template = readFileSync(resolve(repoRoot, ".env.example"), "utf8");
  writeFileSync(target, renderEnv(template, secrets), { mode: 0o600 });
  return { written: true, path: target };
}

function main() {
  const result = setupDev({ repoRoot: process.cwd() });
  console.log(result.written ? `wrote ${result.path} with fresh dev secrets` : `${result.path} already exists, left it alone`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
