# ADR 0004: ProfileService behind DataService, with schema versioning and migrations

- Status: Accepted
- Date: 2026-10-06

## Context

Player saves are the one thing a Roblox game cannot get wrong. The classic failures are item duplication across servers, a save corrupted by NaN or a function, and old saves that no longer match the code.

## Decision

- Saves go through ProfileService, vendored unchanged from the public MadStudioRoblox upstream (Apache-2.0) at a pinned commit. Its session locking means only one server can hold a player's profile at a time, which is what stops cross-server duplication.
- `DataService` is the only module that touches profiles. `GetPlayerProfile(Player)` keeps the familiar API, but changes go through `Update(Player, Mutator)`, which runs `SaveSafety.TryUpdate` and refuses anything unsafe.
- Every save has a `SchemaVersion`. On load, `Migrator.Run` upgrades it on a copy. A save from a newer version, or one whose migration throws, is released untouched and the player is asked to rejoin, so nothing half migrated is ever saved. `Reconcile` then fills missing fields from `Template.Defaults`.
- Before release, the save is checked again. If something wrote unsafe data around `Update`, the last copy that passed is saved instead.
- `StoreSelector` picks the store: Studio never touches live saves, and unknown places never use the Live store.

## Alternatives considered

- **ProfileStore** (the successor by the same author). Newer API, but the owner's production games use ProfileService and the M1 goal is a pattern he can explain from experience. Switching later only touches DataService.
- **Raw DataStoreService.** Session locking, autosave and release on shutdown would all be hand-written, which is exactly the bug-prone part.

## Consequences

- One small facade owns every save, so the economy move to the backend in M2 is a template migration plus changes in one service.
- Players with a newer save can be bounced during a staged rollout instead of losing data.
- The vendored file is excluded from formatting, linting, type checking and the size limit.
