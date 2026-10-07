# ADR 0003: Service and controller lifecycle

- Status: Accepted
- Date: 2026-10-06

## Context

A Roblox game has many server singletons (data, shop, orbs) and client singletons (HUD, input). They depend on each other at startup, and the classic failure modes are a module that yields during setup and stalls everything after it, a module that errors and takes the whole boot down, and remotes that get new listeners late, after players are already firing them.

## Decision

- `ServerStart` uses `Loader.LoadFolders` on `ServerStorage.Classes.Services`. `ClientStart` does the same on `ReplicatedStorage.Classes.Controllers` after `game.Loaded`.
- Loading skips non-ModuleScripts, modules with a truthy `Disabled` attribute, modules named `-Template-`, and class modules that expose `new` or `Get`. A failing require is warned and skipped.
- Order is deterministic: a module's numeric `Priority` field (lower first, default 100), then name.
- `Init` runs on every module in order and must not yield. Each Init runs in a coroutine and the Loader checks it finished. An Init that errors or yields is warned and that module never gets Started.
- After all Inits, the server calls `NetGuard.Seal()`. Listening after the seal is an error.
- `Start` runs on each ready module in its own `task.spawn`, inside `pcall`.
- `ClientStart` lives in `StarterPlayerScripts`, not `ReplicatedFirst`, because controllers need the replicated `Remotes` folder and the player's GUI, and `ReplicatedFirst` would only add a manual wait for both.

## Alternatives considered

- **A framework such as Knit.** Adds a dependency and its own service-to-service remotes. The owner's own pattern is smaller and fully explainable.
- **Dependency graphs between services.** More machinery than M1 needs. `Priority` covers the rare case where order matters.
- **Letting Init yield.** It makes boot order depend on timing and lets one slow DataStore call hold every other service back.

## Consequences

- One broken module never stops the game from booting, and the log says which one broke.
- Anything slow (DataStore loads, waiting for children) belongs in `Start` or in per-player threads.
- Every remote listener exists before any player packet is processed.
