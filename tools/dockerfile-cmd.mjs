#!/usr/bin/env node
// Prints a Dockerfile's CMD argv, one NUL terminated argument each, so a script can run exactly
// the command the image runs: node tools/dockerfile-cmd.mjs backend/Dockerfile
// The CI smoke step uses it to boot the built backend the same way a container would.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Returns the argv of the last CMD (docker build keeps the last one). Only the exec form
// (a JSON list of strings) is accepted, since the shell form adds an sh that eats SIGTERM.
export function dockerfileCmd(text) {
  const lines = text.split(/\r?\n/).filter((line) => /^\s*CMD\s/i.test(line));
  const last = lines.at(-1);
  if (last === undefined) throw new Error("the Dockerfile has no CMD");
  const raw = last.replace(/^\s*CMD\s+/i, "").trim();
  let argv;
  try {
    argv = JSON.parse(raw);
  } catch {
    argv = null;
  }
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((part) => typeof part === "string")) {
    throw new Error("the CMD must use the exec form, a JSON list of strings");
  }
  return argv;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node tools/dockerfile-cmd.mjs <Dockerfile>");
    process.exit(2);
  }
  try {
    process.stdout.write(dockerfileCmd(readFileSync(file, "utf8")).map((part) => `${part}\0`).join(""));
  } catch (error) {
    console.error(`${file}: ${error.message}`);
    process.exit(1);
  }
}
