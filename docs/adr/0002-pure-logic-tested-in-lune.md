# ADR 0002: Pure Logic modules tested in Lune instead of in-Studio TestEZ or Jest-Lua

- Status: Accepted
- Date: 2026-10-06

## Context

Most of the bugs that matter in a Roblox economy are rule bugs: a limiter that refills wrong, a validator that lets an extra key through, a migration that corrupts a save. Those rules need fast tests that run in CI without Roblox Studio.

## Decision

- Game rules live in `game/src/ReplicatedStorage/Shared/Logic`. Those modules never touch `game`, instances, `task`, the clock or randomness. Time and randomness are passed in as arguments.
- Shared modules (`Logic`, `Configs`, `Enums`, `Net/Packets`) never require each other, because Roblox requires take instances and Lune requires take strings. Services, NetGuard, specs and Lune scripts do the wiring.
- Tests are `game/tests/**/*.spec.luau`, written with a small in-repo harness (`Describe`, `It`, `Expect`) and run with `lune run tests/Runner`.
- Roblox glue (services, controllers, NetGuard's remote wiring) is checked by `luau-lsp analyze` in strict mode, `rojo build`, and a manual Studio checklist in `game/README.md` that the owner runs.

## Alternatives considered

- **TestEZ inside Studio.** Needs Studio or Open Cloud to run, so CI cannot gate on it without extra infrastructure.
- **Jest-Lua with run-in-roblox.** Same problem, plus heavier setup.
- **Lune with `@lune/roblox` to fake instances.** Tempting, but fakes of the DataModel drift from the real thing. Keeping logic pure avoids needing them.

## Consequences

- CI runs every rule test in seconds on Linux.
- A few small helpers (deep copy) are duplicated, since shared modules cannot require each other.
- Roblox-only behavior still needs the manual Studio checklist. M4 may add an Open Cloud Luau Execution run.
