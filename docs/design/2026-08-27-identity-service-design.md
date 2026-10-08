# Identity Service - Design

**Date:** 2026-08-27
**Status:** Approved (approach A, vertical slices)
**In Outpost:** this is the original design record. Outpost keeps its auth design and replaces DynamoDB with MySQL (ADR 0007, `docs/adr/0007-mysql-and-redis.md`, written in Task 32); slices 5 (DynamoDB) and 6 (account linking) and `/register` are not carried over.

## Purpose

A working identity and authentication service. The project has two goals:

1. **Working auth implementation.** Implement auth concepts end to end in running, tested code, so
   every design choice is a decision made in code and recorded here.
2. **Documented reasoning.** A tested, documented implementation of the auth flows, with the
   reasoning recorded.

The stack uses a storage layer common in large identity platforms, DynamoDB and Redis, implemented in
TypeScript. There is no frontend here. This is a backend service only.

## Scope

In scope:

- Registration, login, token refresh with rotation and reuse detection, sessions, logout, and account
  linking against a mock provider.
- A real API spec, a service layer, a persistence layer, and a written scalability argument (slice 7).
- The reasoning behind each design choice, such as why Redis and Dynamo were split, why login fails
  closed, and why RS256 over HS256.
- Only the algorithms the service itself needs, hand-rolled as described below.

Out of scope: everything listed under Non-goals.

### Hand-rolled core algorithms

Three components sit on the hot path of authentication and key lookup. They get **hand-rolled
with tests, never installed from a library**, so their limits, eviction rules, and failure behavior
are explicit, owned by the service, and covered by its own tests:

- **Token bucket rate limiter.** Slice 4. The standard practical rate limiting algorithm.
- **Sliding window counter.** Slice 4, alongside the bucket, so the trade-off between the two is
  explicit in code and tests.
- **LRU cache.** Slice 7, backing the JWKS public-key cache. Genuinely needed here, not contrived.

## Non-goals

Cut aggressively. Each of these is a real feature of real identity systems and each is **out of scope**:

- No UI. curl, HTTPie, or Postman only.
- No email delivery, so no verification emails and no password reset delivery.
- No federation with real external providers. Account linking runs against a **mock provider**.
- No admin console, no user management screens.
- No horizontal scaling in practice. Scalability is a **documented design argument**, not a deployed
  reality. That distinction is stated plainly in the docs.

## Architecture

Three processes, all local, orchestrated by Docker Compose:

```
  client (curl)
       |
       v
  identity-service  (Fastify, TypeScript, Node 24)
       |
       +--> DynamoDB Local   durable identity data: users, platform links
       |
       +--> Redis            ephemeral state: sessions, refresh families, rate limits
```

**The storage split is a deliberate design decision.** Durable identity data lives
in Dynamo. Ephemeral, TTL-bound state lives in Redis. Sessions and refresh token families expire
naturally rather than requiring a sweep job, and losing Redis logs everyone out without losing any
account. The reasoning for that trade is recorded here.

### Components

| Component | Purpose | Depends on |
|---|---|---|
| `routes/` | HTTP layer. Fastify schemas in, JSON out. | services |
| `services/` | Business logic. Token issuance, rotation, linking. | repos, crypto |
| `repos/` | Data access. Dynamo and Redis clients behind interfaces. | drivers |
| `crypto/` | Key management, JWT sign and verify, JWKS. | none |
| `middleware/` | Auth guard, rate limiter. | repos |

Repos sit behind interfaces so services can be unit-tested against in-memory fakes without Docker.
Integration tests run against real containers.

## Data model

### DynamoDB, single table `identity`

Single-table design, chosen because it is the idiomatic Dynamo pattern and because partition key
selection and GSI overloading are the core modeling decisions to get right.

| Item | PK | SK | Notes |
|---|---|---|---|
| User profile | `USER#<userId>` | `PROFILE` | holds `passwordHash`, `tokenVersion`, `createdAt` |
| Platform link | `USER#<userId>` | `LINK#<platform>` | one per linked platform |

**GSI1, email lookup for login:** `GSI1PK = EMAIL#<normalizedEmail>`, `GSI1SK = USER`

**GSI2, link resolution and collision detection:** `GSI2PK = PLATFORM#<platform>#<platformUserId>`,
`GSI2SK = USER`

Design notes:

- **Email is normalized before hashing into the key**, lowercased and trimmed, so `Joel@X.com` and
  `joel@x.com` cannot both register.
- **Partitioning on `userId` distributes evenly** because it is a random UUID. Partitioning on email
  or on a tenant would risk hot partitions.
- **Uniqueness is enforced with a conditional write**, `attribute_not_exists(PK)`, not with a read
  followed by a write. The read-then-write version has a race that the conditional write does not.
- **GSI2 makes account linking collision detectable in one query** rather than a scan.

### Redis keyspace

| Key | Type | TTL | Purpose |
|---|---|---|---|
| `session:<sessionId>` | hash | absolute expiry | device metadata, `userId`, issued time |
| `user:<userId>:sessions` | set | none | index for listing and bulk revoke |
| `refresh:<familyId>` | hash | refresh lifetime | current token id, reuse detection state |
| `ratelimit:ip:<ip>` | counter | window | per-IP login attempts |
| `ratelimit:user:<userId>` | counter | window | per-account login attempts |

## Endpoints

```
POST   /register                 create account
POST   /login                    -> access token + refresh token, creates session
POST   /token/refresh            rotation + reuse detection
POST   /logout                   revoke one session
POST   /logout/all               global invalidation via tokenVersion bump
GET    /sessions                 list active devices
DELETE /sessions/:id             remote sign-out
POST   /link/:platform           link external platform account (mock provider)
DELETE /link/:platform           unlink, subject to cooldown
GET    /.well-known/jwks.json    public key discovery
```

## Security decisions, and why

These are the key security decisions. Each is a decision with an alternative that was rejected.

- **Access tokens are short-lived JWTs, 15 minutes. Refresh tokens are long-lived and server-side.**
  Bounds the revocation window without a database lookup on every request.
- **RS256, not HS256.** Asymmetric signing means verifiers need only the public key, which is what
  makes a JWKS endpoint meaningful and what lets other services verify without sharing a secret.
- **Explicit `alg` allowlist on verification.** Never trust the `alg` header from the token. This is
  the defense against the algorithm confusion attack.
- **Refresh rotation with reuse detection.** Every refresh issues a new token and invalidates the old.
  A replayed token means theft, so the entire family is invalidated. This is the core security mechanism
  of the refresh flow, and tests prove it.
- **`tokenVersion` claim for global invalidation.** Bumping one integer on the user record invalidates
  every outstanding access token with no denylist and no scan.
- **Rate limiting on both IP and account.** Per-IP alone fails against distributed attacks. Per-account
  alone lets an attacker lock a specific user out. Both, or neither works.
- **Login fails closed if Redis is unavailable.** For an authentication endpoint, refusing service
  beats allowing unlimited credential stuffing. This is a deliberate trade-off, recorded here rather than assumed.
- **Argon2id for password hashing**, not bcrypt, and definitely not a bare hash.
- **Uniform failure responses on login.** Wrong password and unknown account return the same error, so
  the endpoint cannot be used to enumerate accounts.

## Testing strategy

Unit tests against in-memory fakes for logic. Integration tests against real containers for wiring.

The tests that matter, and that should exist before the code:

1. **Refresh rotation** issues a new token and invalidates the old one.
2. **Reuse detection** invalidates the entire family when a consumed token is replayed.
3. **`logout/all`** rejects access tokens issued before the `tokenVersion` bump.
4. **Rate limiter** blocks after N attempts and recovers after the window.
5. **Link collision** is rejected when a platform identity is already bound to another user.
6. **Conditional write** prevents duplicate registration under concurrent requests.
7. **Algorithm confusion** is rejected: a token signed `none` or `HS256` fails verification.

Tests 2, 3, and 7 guard the most security-critical behavior.

## Build sequence, approach A

One complete, tested, committed vertical slice at a time. Each slice focuses on one area so the
implementation stays narrow.

| Slice | Ships | Area |
|---|---|---|
| 1 | Project skeleton, Docker Compose, `/register`, `/login`, RS256 JWT | OAuth and OIDC |
| 2 | `/token/refresh` with rotation and reuse detection | tokens |
| 3 | Redis sessions, `/sessions`, `/logout`, `/logout/all` | sessions |
| 4 | Rate limiting on login, both dimensions. **Token bucket and sliding window hand-rolled.** | rate limiting |
| 5 | Dynamo single-table model and GSIs finalized | DynamoDB |
| 6 | `/link/:platform`, collision handling, unlink cooldown | account linking |
| 7 | JWKS with a **hand-rolled LRU** key cache, OpenAPI spec generation, README | REST API design |

**Slices 1 to 4 persist users through the repo interface backed by an in-memory fake.** Only slice 5
swaps in real DynamoDB Local and finalizes the single-table model and GSIs. That ordering is
deliberate rather than lazy: modeling Dynamo well requires knowing the real access patterns, and those
are not known until login, refresh, and sessions exist. This order surfaces data-model decisions early
without locking them in before the access patterns are known. The repo interface is what keeps the
swap cheap.

Slices are independently shippable. Every slice leaves a working, tested service.

## Optional phase 2: Java port

Optional, lowest priority, only after slice 7. A port of the single refresh-token endpoint to a
second stack (Spring Boot) would compare the same refresh flow across two implementations.

## Open risks

- **Slice 6 is the most likely to overrun.** Account linking has the most edge cases. If needed,
  ship linking without the unlink cooldown and note the omission in the README.
- **Dynamo single-table design is genuinely hard.** Slice 5 may take longer than planned. That is
  acceptable because it is also the most important modeling decision in the service.
