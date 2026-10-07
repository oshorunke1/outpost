#!/usr/bin/env bash
# Runs every Luau check that CI runs, in the same order, so a green run here means a green CI job.
# Run it from anywhere inside the repo with bash tools/ci/luau-check.sh
set -euo pipefail

cd "$(dirname "$0")/../../game"
export PATH="$HOME/.rokit/bin:$PATH"

LUAU_LSP_TYPES_URL="https://raw.githubusercontent.com/JohnnyMorganz/luau-lsp/1.69.0/scripts/globalTypes.d.luau"

Dirs=()
for Dir in src tests scripts; do
  if [ -d "$Dir" ]; then Dirs+=("$Dir"); fi
done

echo "== strict headers"
Missing=""
while IFS= read -r -d '' File; do
  if [ "$(head -n 1 "$File" | tr -d '\r')" != "--!strict" ]; then
    Missing="$Missing $File"
  fi
done < <(find "${Dirs[@]}" -name '*.luau' -print0)
if [ -n "$Missing" ]; then
  echo "these files do not start with --!strict:$Missing"
  exit 1
fi

echo "== format"
stylua --check "${Dirs[@]}"

echo "== lint"
if [ ! -f roblox.yml ]; then selene generate-roblox-std; fi
selene "${Dirs[@]}"

echo "== types (strict)"
rojo sourcemap default.project.json --output sourcemap.json --include-non-scripts
if [ ! -f globalTypes.d.luau ]; then curl -sSfL -o globalTypes.d.luau "$LUAU_LSP_TYPES_URL"; fi
luau-lsp analyze --platform roblox --sourcemap sourcemap.json --definitions @roblox=globalTypes.d.luau --ignore "vendor/**" src

echo "== unit tests"
lune run tests/Runner

echo "== build"
mkdir -p build
rojo build default.project.json --output build/Outpost.rbxl

echo "all Luau checks passed"
