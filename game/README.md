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
| `src/ServerStorage/Classes/Util` | Server helpers such as NetGuard, RobloxTransport and the shared Backend client |
| `src/ServerStorage/Configs` | Server only settings, such as where the backend lives. Players never receive these |
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

- [ ] Join in Play Solo. Server output shows `[DataService] using the Mock store Outpost_Players_Mock, ledger economy false` and `[DataService] loaded <you> at schema v1 (from v1), Legacy economy`. Studio keeps the M1 Coins in the save unless StudioLedger is on.
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

### Backend client

- [ ] Play Solo. In the server command bar run `print(require(game.ServerStorage.Classes.Util.Backend).Mode())`. Output shows `[Backend] using the Mock transport` once, then `Mock`. Run it again and the `using` line does not repeat.
- [ ] In the server command bar run `local R = require(game.ServerStorage.Classes.Util.Backend).Client():Send({ Method = "GET", Path = "/v1/flags" }) print(R.Status, R.Body.flags.ShopEnabled)`. Output shows `200 true`.
- [ ] Run `require(game.ServerStorage.Classes.Util.Backend).MockControls().FailNext(503, "flags_unavailable")`, then the flags call again. It comes back 200 after a short retry, because one 503 is retried.
- [ ] In the client command bar run `print(game.ServerStorage:FindFirstChild("Configs"))`. Output shows `nil`, so players never see the backend settings.
- [ ] Still in Play Solo, run `print(require(game.ServerStorage.Classes.Util.Backend).EconomyLive())` in the server command bar. Output shows `false`, so Studio keeps the old DataStore Coins by default.
- [ ] Try the real timeout race in the server command bar. Run `local HttpCall = require(game.ReplicatedStorage.Shared.Logic.Backend.HttpCall) local Scheduler = require(game.ServerStorage.Classes.Util.RobloxTransport).Scheduler local Began = os.clock() print(HttpCall.Race(function() task.wait(5) print("work finished") return "late" end, 1, Scheduler)) print(os.clock() - Began)`. After about 1 second the output shows `TimedOut nil` and a time close to 1. About 4 seconds later `work finished` prints once, and no error and no second `TimedOut` line follow.
- [ ] Run the same line with `task.wait(0.2)` in place of `task.wait(5)`. The output shows `work finished`, then `Done late` and a time close to 0.2. Nothing more prints, because the timer was cancelled.
- [ ] Studio opt in. Set `StudioLedger = true` in `src/ServerStorage/Configs/Backend.luau` with Rojo connected, then Play Solo. The server output shows `[DataService] using the Mock store Outpost_Players_Mock` even on a test place, and `EconomyLive()` prints `true`. Set it back to false afterwards. Studio never writes the real test store while it is on.
- [ ] On a published server with `Configs/Backend` Enabled false, the first backend call logs `[Backend] using the Offline transport` and nothing is sent. Check the server console in the Developer Console. `EconomyLive()` is false there.
- [ ] Only once a backend is deployed. Turn on Allow HTTP Requests in Game Settings, Security, and save, so live servers may use HttpService at all. Without it every request fails and the only sign is a `[RobloxTransport]` warning every 30 seconds.
- [ ] Only once a backend is deployed. Create the `OutpostApiKey` secret in the Creator Hub, on the experience's Secrets page, with its domain set to the host of `BaseUrl` (for example `outpost.example.com`, no https and no path). Secrets added in Studio's own settings only exist inside Studio, and Studio always uses the mock, so a published server never sees them. Then set Enabled true and BaseUrl, and publish.
- [ ] On that published server, the server console shows `[Backend] using the Roblox transport`, `EconomyLive()` is true, and a flags call from the server console returns 200. Delete the secret, or set a domain that does not match, and a new server logs that the secret is missing or that the request failed, and stays off the ledger.

### Ledger economy

These need `StudioLedger = true` in `src/ServerStorage/Configs/Backend.luau` with Rojo connected. Set it back to false afterwards. In the commands, `E` is `require(game.ServerStorage.Classes.Services.EconomyService)`, `D` is `require(game.ServerStorage.Classes.Services.DataService)`, `B` is `require(game.ServerStorage.Classes.Util.Backend)`, `R` is `require(game.ReplicatedStorage.Shared.Logic.Backend.Requests)` and `P` is `game.Players:GetPlayers()[1]`, all in the server command bar.

- [ ] Play Solo. Server output shows `[EconomyService] Coins live in the backend ledger on this server` and `loaded <you> at schema v2 (from v2), Ledger economy`. The HUD shows `Coins loading` for a moment, then `Coins 0` once the join lands.
- [ ] Collect 3 orbs. The HUD goes up by 5 each time straight away. About 30 seconds later `print(B.Client():Send(R.Wallet(P.UserId)).Body.balance)` prints 15, the same as the HUD.
- [ ] Legacy credit shows in the wallet. Run `D:Update(P, function(S) S.LegacyCoins = 1234 S.LegacyCredited = nil end) E:RunJoinSteps(P)`. Within a few seconds the HUD goes up by 1234, the wallet call prints 1234 more than before, and `print(D:GetData(P).LegacyCredited)` prints `true`.
- [ ] Rejoin after a crash mid credit. Run `D:Update(P, function(S) S.LegacyCredited = nil end) E:RunJoinSteps(P)`, which is what a server that crashed before the mark landed leaves behind. The HUD and the wallet do not change, because the same `legacy-<UserId>-<n>` keys replay, and `LegacyCredited` is `true` again.
- [ ] Purchase with the backend down. Collect at least 25 Coins, run `B.MockControls().FailNext(503, "ledger_unavailable", nil, 3)`, then click Buy. The status says `The shop is busy, try again`, the button still offers the hat, and the wallet call shows the same balance as before.
- [ ] Purchase whose answer was lost after the charge. Run `B.MockControls().FailNext(503, "ledger_unavailable", nil, 2) B.MockControls().LoseNextAnswer()`, then click Buy. The status says `The shop is busy, try again`, but the wallet already dropped by 25. Click Buy again. It says `Bought it!` and the wallet has not dropped a second time, because the second click replays the first charge under the same key.
- [ ] Save confirmation. Run `print(D:SaveNow(P, 30))`. Within a few seconds it prints `true`, and `print(P and D:GetData(P) and true)` still prints `true`. On the published test place run the same line in the server console, which proves the SaveSeq meta tag round trip on the real DataStore.
- [ ] Purchase crash window. Collect at least 25 Coins, run `local Real = D.SaveNow D.SaveNow = function() return false end`, then click Buy. It says `Bought it!`, but `print(#B.Client():Send(R.Unfulfilled(P.UserId)).Body.purchases)` prints 1, because nothing is acknowledged until a save is confirmed. Run `D.SaveNow = Real E:RunJoinSteps(P)`. The list is empty after a few seconds, the hat is still owned, and the wallet dropped by 25 once.
- [ ] Only on a published server. Buy the hat, then shut the server down from the Creator Hub within 30 seconds. Rejoin on a new server. The hat is owned and the wallet dropped by 25 once.
- [ ] Only on a published server. Same-server rejoin. Leave and rejoin the same server, for example by following a friend who is still in it. The HUD shows the same Coins as before you left, not `Coins 0`.
- [ ] Two quick clicks. With at least 25 Coins, click Buy twice as fast as you can. One click says `Bought it!` and the other says already owned or unavailable. The wallet drops by 25 once.
- [ ] Leave with Coins waiting. Collect 1 orb and stop the session within 30 seconds. The server output shows no `[EconomyService]` warning about Coins the backend never confirmed.
- [ ] Studio default. With `StudioLedger = false`, Play Solo shows `[EconomyService] the ledger economy is off on this server, Coins stay in the save` and the Orbs and Shop checks above behave exactly as in M1.
- [ ] Only once a backend is deployed. Migration of a v1 save with Coins. On the published test place, join with an account whose M1 test save had Coins. The server console shows `loaded <you> at schema v2 (from v1), Ledger economy`, the HUD shows those Coins after a few seconds, and the backend has `legacy_migration` rows with keys `legacy-<UserId>-1` and up. Rejoin and the balance is the same with no new legacy rows.
- [ ] Only once a backend is deployed. A save that moved to v2 never goes back. Turn Enabled off and publish, then join with that account. The console shows `Paused economy`, the HUD shows `Coins paused` (never `Coins 0`), orbs pay nothing, Buy says unavailable, and the save still has no `Coins` field. Turn Enabled back on and the Coins are all there.
- [ ] Only on a published server. Rejoin while the old join is still trying. With the backend unreachable, collect an orb, leave, and rejoin the same server once the backend is back. The HUD leaves `Coins loading` within a minute and Buy works, because the old visit's join loop stops by itself and never blocks the new one.

### Flags and telemetry

In the commands, `F` is `require(game.ServerStorage.Classes.Services.FlagService)` and `B` is `require(game.ServerStorage.Classes.Util.Backend)`, both in the server command bar. FlagService asks for flags once a minute, so give each flag change up to 60 seconds.

- [ ] Play Solo. Server output shows `[ServerStart] 6 of 6 services ready`, so FlagService and TelemetryService booted, and `print(F:Value("ShopEnabled"), F:Value("OrbSpawnMultiplier"))` prints `true 1`.
- [ ] Shop switch. Run `B.MockControls().SetFlag("ShopEnabled", false)` and wait until `print(F:Value("ShopEnabled"))` prints `false`. Click Buy with enough Coins. The status says `The shop is busy, try again` and no Coins move. Set it back to `true`, wait a minute, and Buy works again.
- [ ] Orb speed. Run `B.MockControls().SetFlag("OrbSpawnMultiplier", 4)`, wait a minute, then collect an orb. A new one appears in under a second instead of about 3. Set it to `100` and it is still under a second, never instant. Set it to `1` afterwards.
- [ ] Telemetry fails open. Fire the bad `Orb.Collect` call from the Orbs checks, then within 10 seconds run `B.MockControls().FailNext(503, "unavailable", nil, 10)`. Soon after, the output shows one `[TelemetryService] lost a telemetry batch of N events` warning with N at least 1, the game keeps running, and the next batch goes through with no warning.
- [ ] Only once a backend is deployed. Flags follow the database. Run `UPDATE flags SET flag_value = CAST('false' AS JSON) WHERE flag_key = 'ShopEnabled'`. Within about a minute, plus the backend's short flag cache, Buy on a live server says `The shop is busy, try again`. Set it back to `true` and Buy works again within the same time.
- [ ] Only once a backend is deployed. Telemetry lands. Play for a minute, collecting orbs and buying once. `SELECT metric, event_count FROM telemetry_rollups ORDER BY bucket_start DESC` shows `player_join`, `orb_collected` and `purchase_result` rows. Leave, and a `player_leave` row follows.
- [ ] Only once a backend is deployed. A dropped packet shows up. Fire the bad `Orb.Collect` call from the client console. A `netguard_drop` row appears in `telemetry_rollups` with dims `packet` `Orb.Collect` and `reason` `BadPayload`. Firing it 20 times in a loop adds about one event per 5 seconds, not 20.
- [ ] Only on a published server. Shut the server down from the Creator Hub right after collecting a few orbs. The server console shows no `[TelemetryService]` warning, and the rollup has those `orb_collected` events, sent inside the same shutdown window as the economy flush.
