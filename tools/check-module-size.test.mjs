import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { countLines, findOversized, LINE_LIMIT } from "./check-module-size.mjs";

// Builds a throwaway repo folder with the given files and returns its path.
function makeRepo(files) {
  const root = mkdtempSync(join(tmpdir(), "outpost-size-"));
  for (const [relativePath, text] of Object.entries(files)) {
    const fullPath = join(root, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, text);
  }
  return root;
}

function linesOf(count, eol = "\n") {
  return Array.from({ length: count }, (_, i) => `-- line ${i + 1}`).join(eol) + eol;
}

test("the limit is 700", () => {
  assert.equal(LINE_LIMIT, 700);
});

test("countLines ignores one trailing newline and treats CRLF like LF", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("a"), 1);
  assert.equal(countLines("a\n"), 1);
  assert.equal(countLines("a\nb"), 2);
  assert.equal(countLines("a\r\nb\r\n"), 2);
  assert.equal(countLines("a\n\n"), 2);
});

test("a 700 line file passes and a 701 line file fails", () => {
  const root = makeRepo({
    "game/src/Ok.luau": linesOf(700),
    "game/src/TooBig.luau": linesOf(701),
  });
  try {
    assert.deepEqual(findOversized({ repoRoot: root }), [{ path: "game/src/TooBig.luau", lines: 701 }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CRLF files are measured the same as LF files", () => {
  const root = makeRepo({ "mcp/src/server.ts": linesOf(701, "\r\n") });
  try {
    assert.deepEqual(findOversized({ repoRoot: root }), [{ path: "mcp/src/server.ts", lines: 701 }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("vendor and node_modules folders are skipped", () => {
  const root = makeRepo({
    "game/src/vendor/Big.luau": linesOf(900),
    "tools/node_modules/pkg/index.js": linesOf(900),
  });
  try {
    assert.deepEqual(findOversized({ repoRoot: root }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("files that are not source code are ignored", () => {
  const root = makeRepo({ "game/src/Notes.md": linesOf(900), "game/src/data.json": linesOf(900) });
  try {
    assert.deepEqual(findOversized({ repoRoot: root }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("roots that do not exist yet are skipped", () => {
  const root = makeRepo({ "game/src/Ok.luau": linesOf(3) });
  try {
    assert.deepEqual(findOversized({ repoRoot: root, roots: ["backend/src", "game/src"] }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
