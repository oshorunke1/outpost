# ADR 0005: Server-authoritative remotes with one declarative packet registry

- Status: Accepted
- Date: 2026-10-06

## Context

Every RemoteEvent is an open door for exploiters. They can fire any remote, at any rate, with any arguments, including extra arguments, extra table keys, NaN, and values that are the wrong type. Ad hoc checks inside each handler get forgotten.

## Decision

- `Shared/Net/Packets.luau` is the only list of remotes. Each entry has a name, a direction, a payload spec, and (for client to server packets) a token bucket rate limit.
- `NetGuard.Listen(Name, Handler)` is the only way to handle a client packet. NetGuard asks `PacketGate`, a pure module, whether each packet gets through. The checks run in a fixed order: known packet, right direction, a listener exists, at most one argument, rate limit, payload shape.
- Payload checks refuse extra keys, metatables, NaN, infinity and invalid UTF-8.
- The rate limit is a token bucket per player per packet, spent before payload validation so junk spam still drains it.
- Dropped packets are logged at most once per player per packet every 5 seconds.
- Handlers run in `task.spawn` with `xpcall`, and trust only the `Player` argument. Prices, distances and ownership are always computed on the server.
- Plain `RemoteEvent`s are used. There is no ByteNet or other serialization dependency.

## Alternatives considered

- **ByteNet.** Smaller packets, but it hides the wire format behind a dependency the backend and the manifest export would also need to understand. Bandwidth is not a bottleneck for this game.
- **A sliding window limiter.** It is exact but stores a timestamp per call. A token bucket uses two numbers per key and allows short, honest bursts.
- **Validation inside each handler.** Easy to forget once, which is all an exploiter needs.

## Consequences

- Adding a remote means one registry entry, and the manifest and docs pick it up automatically.
- A forged or spammy call costs the server a table lookup and a few comparisons.
- `PacketGate` is fully unit tested in Lune. Only the thin Roblox wiring in NetGuard needs the Studio checklist.
