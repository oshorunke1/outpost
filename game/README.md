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
| Every check in the `luau` CI job | `bash ../tools/ci/luau-check.sh` |
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

## Third-party code

`vendor/ProfileService.luau` is ProfileService by loleris (MadStudioRoblox), copied byte for byte from [MadStudioRoblox/ProfileService](https://github.com/MadStudioRoblox/ProfileService) at commit `d736800444eda6bf75b18397f77dfb2c8f31f60f` (the upstream file is `ProfileService.lua`; only the extension changed). It is licensed under the Apache License 2.0, included as `vendor/LICENSE-ProfileService.txt`. It is never edited here.

## Studio playtest checklist

The owner runs these by hand in Studio. Nothing here is automated.

### Boot and networking

- [ ] Start a Play Solo session. The server output shows `[ServerStart] N of N services ready` exactly once, and the client output shows `[ClientStart] N of N controllers ready` exactly once.
- [ ] `ReplicatedStorage.Remotes` exists and holds one RemoteEvent per packet in `Shared/Net/Packets.luau`.
- [ ] Put a ModuleScript that errors on require into `ServerStorage.Classes.Services` in Studio. Output shows `[Loader] <name> failed to load` and every other service still reports ready. Delete it afterwards.

### Data

- [ ] Join in Play Solo. Server output shows `[DataService] using the Mock store Outpost_Players_Mock` and `[DataService] loaded <you> at schema v1 (from v1)`.
- [ ] Your Player has a `ProfileLoaded` BindableEvent child and the attribute `ProfileLoaded = true`.
- [ ] Stop the session. Server output shows `[DataService] released <you>` with no errors.
- [ ] Set the attribute `ForceMockData = true` on ServerStorage in Edit mode, then Play Solo. Output still says the Mock store. Remove the attribute afterwards.
- [ ] Write a save with a NaN value into the Mock store from the command bar, then join. The player is kicked and the stored data is left unchanged.

### Orbs

- [ ] Play Solo. A ring of 12 glowing yellow orbs appears around the spawn, inside `Workspace.Orbs`.
- [ ] Walk into an orb. It disappears, a new orb appears about 3 seconds later, and the HUD Coins value goes up by 5 once the HUD from the Shop step exists.
- [ ] In the client command bar, fire a far away pickup with `game.ReplicatedStorage.Remotes["Orb.Collect"]:FireServer({ OrbId = <an id from Workspace.Orbs that is far from you> })`. The orb stays and no Coins are paid.
- [ ] Fire `game.ReplicatedStorage.Remotes["Orb.Collect"]:FireServer({ OrbId = "1" })` from the client command bar. The server output shows one `[NetGuard] dropped Orb.Collect ... reason BadPayload` line.
- [ ] Fire the same bad call 20 times in a loop. Only one dropped line appears per 5 seconds.

### Shop and HUD

- [ ] Play Solo. The top left shows `Coins 0`, a `Buy Red Hat (25)` button, and an empty status line.
- [ ] Click Buy with fewer than 25 Coins. The status says `Not enough Coins yet` and Coins do not change.
- [ ] Collect 5 orbs (25 Coins), click Buy. The status says `Bought it!`, Coins drop to 0, and the button says `Red Hat owned`.
- [ ] Click Buy again. The status says `You already own that` and Coins stay the same.
- [ ] From the client command bar, fire `game.ReplicatedStorage.Remotes["Shop.Buy"]:FireServer({ ItemId = "RedHat", Price = 0 })`. Server output shows one `dropped Shop.Buy ... reason BadPayload` line and nothing is bought.
- [ ] Fire `Shop.Buy` 30 times in a loop from the client command bar. Server output shows `reason Throttled` at most once per 5 seconds, and at most one purchase happens.
