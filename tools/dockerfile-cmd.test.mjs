import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dockerfileCmd } from "./dockerfile-cmd.mjs";

test("reads the exec form CMD as its argv", () => {
  const text = 'FROM node:22\nWORKDIR /app\nCMD ["node", "--import", "./dist/signals.js", "dist/server.js"]\n';
  assert.deepEqual(dockerfileCmd(text), ["node", "--import", "./dist/signals.js", "dist/server.js"]);
});

test("the last CMD wins, the same as docker build, including one in an earlier stage", () => {
  const text = 'FROM node:22 AS build\nCMD ["echo", "build"]\nFROM node:22\ncmd ["node", "server.js"]\n';
  assert.deepEqual(dockerfileCmd(text), ["node", "server.js"]);
});

test("refuses a shell form CMD, a missing CMD and a CMD that is not a list of strings", () => {
  assert.throws(() => dockerfileCmd("FROM node:22\nCMD node server.js\n"), /exec form/);
  assert.throws(() => dockerfileCmd("FROM node:22\n"), /no CMD/);
  assert.throws(() => dockerfileCmd('FROM node:22\nCMD ["node", 3]\n'), /exec form/);
});

test("the backend image CMD is the same command as the package start script", () => {
  const cmd = dockerfileCmd(readFileSync(new URL("../backend/Dockerfile", import.meta.url), "utf8"));
  const pkg = JSON.parse(readFileSync(new URL("../backend/package.json", import.meta.url), "utf8"));
  assert.equal(cmd.join(" "), pkg.scripts.start);
});
