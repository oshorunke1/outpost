#!/usr/bin/env node
// Fails when any Luau or TypeScript/JavaScript source file is longer than the line limit.
// Run it from the repo root. CI runs it in the repo-hygiene job.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const LINE_LIMIT = 700;
export const DEFAULT_ROOTS = [
  "game/src",
  "game/tests",
  "game/scripts",
  "backend/src",
  "backend/test",
  "backend/scripts",
  "mcp/src",
  "evals/runner/src",
  "tools",
];

const SOURCE_EXTENSIONS = new Set([".luau", ".lua", ".ts", ".tsx", ".mts", ".mjs", ".js"]);
const SKIPPED_FOLDERS = new Set(["node_modules", "vendor", "dist", "build", ".git"]);

// Counts lines the way an editor shows them. CRLF counts like LF, and one trailing newline is not an extra line.
export function countLines(text) {
  const normalized = text.replace(/\r\n/g, "\n");
  if (normalized.length === 0) return 0;
  const newlines = (normalized.match(/\n/g) ?? []).length;
  return normalized.endsWith("\n") ? newlines : newlines + 1;
}

function* walk(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const fullPath = join(folder, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_FOLDERS.has(entry.name)) yield* walk(fullPath);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
      yield fullPath;
    }
  }
}

export function findOversized({ repoRoot, roots = DEFAULT_ROOTS, limit = LINE_LIMIT }) {
  const offenders = [];
  for (const root of roots) {
    const absoluteRoot = resolve(repoRoot, root);
    if (!existsSync(absoluteRoot) || !statSync(absoluteRoot).isDirectory()) continue;
    for (const file of walk(absoluteRoot)) {
      const lines = countLines(readFileSync(file, "utf8"));
      if (lines > limit) {
        offenders.push({ path: relative(repoRoot, file).split("\\").join("/"), lines });
      }
    }
  }
  return offenders.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function main() {
  const offenders = findOversized({ repoRoot: process.cwd() });
  if (offenders.length === 0) {
    console.log(`module size ok, nothing over ${LINE_LIMIT} lines`);
    return 0;
  }
  for (const offender of offenders) {
    console.error(`${offender.path} has ${offender.lines} lines (limit ${LINE_LIMIT})`);
  }
  console.error(`${offenders.length} file(s) over the limit. Split them into smaller modules.`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
