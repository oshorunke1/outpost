# Outpost game

The Roblox side of Outpost: a strict-mode Luau framework (Loader, NetGuard, DataService) and a tiny sample game, "Orbs", that exists only to exercise it.

## Quickstart

Install [Rokit](https://github.com/rojo-rbx/rokit), then from this folder:

```bash
rokit install
lune run tests/Runner
rojo serve
```

Connect the Rojo plugin in Studio to see the game. No backend and no Docker are needed for M1.

## Commands

| What | Command (from `game/`) |
|---|---|
| Unit tests | `lune run tests/Runner` |
| One spec file | `lune run tests/Runner Migrator` |
| Format | `stylua src tests scripts` |
| Lint | `selene src tests scripts` |
| Every CI check | `bash ../tools/ci/luau-check.sh` |
| Build a place file | `rojo build default.project.json --output build/Outpost.rbxl` |

## Layout

| Folder | What lives there |
|---|---|
| `src/ReplicatedStorage/Shared/Logic` | Pure rules with no `game` access, each with a Lune spec in `tests/` |
| `src/ReplicatedStorage/Shared/Net/Packets.luau` | The one list of every remote |
| `src/ServerStorage/Classes/Services` | Server singletons with `Init` and `Start` |
| `src/ReplicatedStorage/Classes/Controllers` | Client singletons with `Init` and `Start` |
| `src/ServerStorage/Classes/Util` | Server helpers such as NetGuard |
| `vendor/` | Third-party code, never edited |

## Studio playtest checklist

The owner runs these by hand in Studio. Nothing here is automated.

### Boot and networking

- [ ] Start a Play Solo session. The server output shows `[ServerStart] N of N services ready` exactly once, and the client output shows `[ClientStart] N of N controllers ready` exactly once.
- [ ] `ReplicatedStorage.Remotes` exists and holds one RemoteEvent per packet in `Shared/Net/Packets.luau`.
- [ ] Put a ModuleScript that errors on require into `ServerStorage.Classes.Services` in Studio. Output shows `[Loader] <name> failed to load` and every other service still reports ready. Delete it afterwards.

### Data

### Orbs

### Shop and HUD
