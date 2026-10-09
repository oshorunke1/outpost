import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSecrets, setupDev } from "./setup-dev.mjs";

test("setupDev fills empty keys once and never overwrites an existing .env", () => {
  const root = mkdtempSync(join(tmpdir(), "outpost-env-"));
  try {
    writeFileSync(join(root, ".env.example"), "# comment\nKEEP=as-is\nMYSQL_ROOT_PASSWORD=\nOUTPOST_GAME_API_KEY=\nUNKNOWN=\n");
    const first = setupDev({ repoRoot: root, secrets: { MYSQL_ROOT_PASSWORD: "r00t", OUTPOST_GAME_API_KEY: "opk_game-server.k" } });
    assert.equal(first.written, true);
    assert.equal(
      readFileSync(join(root, ".env"), "utf8"),
      "# comment\nKEEP=as-is\nMYSQL_ROOT_PASSWORD=r00t\nOUTPOST_GAME_API_KEY=opk_game-server.k\nUNKNOWN=\n",
    );
    const second = setupDev({ repoRoot: root, secrets: { MYSQL_ROOT_PASSWORD: "changed" } });
    assert.equal(second.written, false);
    assert.match(readFileSync(join(root, ".env"), "utf8"), /MYSQL_ROOT_PASSWORD=r00t/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("makeSecrets gives a well formed API key and a test URL that uses the root password", () => {
  const secrets = makeSecrets();
  assert.match(secrets.OUTPOST_GAME_API_KEY, /^opk_game-server\.[A-Za-z0-9_-]{43}$/);
  assert.equal(secrets.TEST_MYSQL_URL, `mysql://root:${secrets.MYSQL_ROOT_PASSWORD}@127.0.0.1:3306`);
  assert.notEqual(secrets.MYSQL_ROOT_PASSWORD, secrets.MYSQL_APP_PASSWORD);
});
