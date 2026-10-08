# ADR 0006: Naming conventions per language and the 700-line module limit

- Status: Accepted
- Date: 2026-10-06

## Context

Outpost mixes Luau (the game) with TypeScript (backend and MCP, from M2). Each ecosystem has strong naming habits. Luau code in the owner's Roblox work uses PascalCase for everything, while TypeScript tooling, lint rules and libraries expect camelCase. Large modules were the main source of hard-to-review changes in past Roblox projects.

## Decision

- Luau uses PascalCase for variables, functions, parameters, fields and file names. The exceptions are `self`, the `new` constructor, and Roblox or Lune API names.
- TypeScript and JavaScript use standard camelCase, with PascalCase for types and classes.
- JSON contracts in `contracts/` use camelCase keys, because TypeScript is their main reader.
- No Luau, TypeScript or JavaScript source module may go over 700 lines. `tools/check-module-size.mjs` enforces this in the `repo-hygiene` CI job. A module that grows past the limit gets split into a facade plus focused child modules, keeping the facade's API.
- Luau comments are casual and beginner-friendly.

## Alternatives considered

- **One naming style everywhere.** Forcing camelCase on Luau fights the owner's daily habits and every existing Roblox snippet, which would then need translating before it could be read and reasoned about without a guide. Forcing PascalCase on TypeScript fights ESLint defaults and every library.
- **A softer limit (a warning only).** Warnings get ignored. A hard limit costs one split now and then and keeps every file readable in one sitting.

## Consequences

- A reviewer sees two styles in one repo, which this ADR explains up front.
- Line counts treat CRLF like LF so Windows checkouts measure the same as CI.
- `vendor/`, `node_modules/`, `dist/` and `build/` are never measured, since that code is not ours.
