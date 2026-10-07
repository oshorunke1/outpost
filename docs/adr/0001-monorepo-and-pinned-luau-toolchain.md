# ADR 0001: Single monorepo with pnpm workspaces and a Rokit-pinned Luau toolchain

- Status: Accepted
- Date: 2026-10-06

## Context

Outpost tells one system story: a Roblox game server calls a backend, and AI agents operate both through an MCP server. The pieces share contracts (the framework manifest now, OpenAPI from M2). Reviewers usually open one link.

## Decision

- One repository holds `game/` (Rojo and Luau), and from later milestones `backend/`, `mcp/`, `evals/`, `contracts/` and `deploy/`.
- TypeScript packages are pnpm workspaces listed in `pnpm-workspace.yaml`. M1 has none yet.
- The Luau toolchain is pinned in `game/rokit.toml`: Rojo 7.6.1, Lune 0.10.5, Selene 0.31.0, StyLua 2.5.2, luau-lsp 1.69.0. CI installs the same pins.
- Rojo stays on 7.6.1 because Windows Smart App Control blocks the 7.7 binary on the main development machine.

## Alternatives considered

- **Three linked repos** (framework, backend, MCP). Each is smaller, but contracts drift across repos and the system story, the main senior signal, gets lost.
- **Monorepo plus a standalone identity-service.** Rejected on Oct 6 2026, the identity-service folds into `backend/` in M2.
- **Aftman or Foreman for tools.** Rokit reads the same manifests, is maintained by the Rojo org, and is what the owner already uses.

## Consequences

- One CI run can check that the game, backend and MCP agree on contracts.
- CI is polyglot. Path filters keep a Luau-only change from running TypeScript jobs.
- The README needs a "what to look at first" section per audience, since a Roblox reviewer would otherwise land on Node files.
