---
title: "0215 — One person, one encrypted sync space, many writable hosts"
description: "Cognia operates an official, optional account on Cloudflare Workers (Better Auth, standard OIDC; self-hosters keep Logto). A signed-in person owns one end-to-end encrypted sync space: one Durable Object per account holding a signed, encrypted op log, client-made encrypted snapshots and blobs in R2, per-field HLC last-writer-wins merge, and epoch keys sealed to each device and to a recovery public key. Every enrolled desktop, phone and browser is a writable replica. Data replicates everywhere; execution (connectors, schedules, live turns, credential refresh) runs only under a lease granted by the account object. Feishu login identity, IM bot credentials and Feishu user authorization are three different things and are kept apart."
---

# ADR 0215 — One person, one encrypted sync space, many writable hosts

**Status:** Accepted (design; implementation not started)
**Date:** 2026-10-04
**Amends:** [ADR-0054](./0054-local-multi-account-isolation) (account sync in scope; at-rest encryption exists), [ADR-0097](./0097-cross-device-settings-contract-and-companion-reach) D5 (per-field clocks adopted for synced tables), [ADR-0103](./0103-cross-host-session-handoff) (single writable copy applies to a live turn, not to data), [ADR-0116](./0116-host-authoritative-session-state) (authority is the lease holder), [ADR-0136](./0136-cross-device-placement) (inter-host leases now exist), [ADR-0149](./0149-a-person-is-not-a-device) §6 (its premise for rejecting E2E is stale; personal sync is E2E)
**Related:** [ADR-0001](./0001-backup-schema-v3) (backup package), [ADR-0021](./0021-webrtc-datachannel-wan-transport) and [ADR-0170](./0170-cognia-relay-and-connectivity-center) (pairing stays), [ADR-0027](./0027-mobile-offline-and-discovery) (companion sync stays for unsigned pairs), [ADR-0059](./0059-cloud-deployment-headless-brain) (headless host), [ADR-0091](./0091-lark-unified-identity-dual-entry) (Feishu principals), [ADR-0167](./0167-the-schedule-belongs-to-the-account) (schedules), [ADR-0209](./0209-a-cogpack-pins-plugins-and-a-cogset-owns-what-runs) (plugin intent)
**Wire format:** [Account Sync Protocol v1](../data/account-sync-protocol)
**Design and grill record:** `docs/superpowers/specs/2026-10-04-official-account-and-e2e-sync-design.md` (local working notes; this ADR is authoritative)

## Context

Cognia has three identity worlds that never meet.

- **Personal data is local-first and single-writer.** A LocalProfile (`acct_…`) owns an encrypted per-profile Dexie database on one Host. Phones and browsers mirror about 50 of roughly 370 tables by pull and queue their writes back (ADR-0027). There is no cloud account, two desktops share nothing, and a phone whose Host is offline can only read.
- **Org collaboration has a real account model that nobody sees.** ADR-0149 built `usr_`/`org_`, Logto sign-in and a Postgres collab server, but the sign-in gate appears only when a Host reports `COGNIA_DEPLOYMENT_MODE=multi-tenant`. An ordinary install reports `none` and passes straight through.
- **The Cloudflare edge has no user concept.** Signaling is key-bound by design; share uploads use a global secret or a per-share owner token (its org grant path is built but `SHARE_GRANT_KEY` is unset); update and status admin use static secrets or an empty Access config. Across the cloud there are five OIDC/JWT verifiers and three copies of the grant format.

The repo already has most of the parts a multi-writer engine needs: string primary keys on every synced table, a governed table catalog with a per-table delete strategy, Dexie DBCore middlewares that see every write, a tombstone table, a per-field settings classification (`packages/agent-config-types/src/settings-sync.ts`), versioned rotatable DEKs with pairing export (`lib/rag/profile-dek-store.ts`), and Yjs for canvas. What blocks it: every clock and cursor is device-local (`updatedAt`, the per-database `syncRevision`), ids come from `Date.now() + Math.random()` (about 31 bits), `settings` is one row with one timestamp, `issueCounters` allocates sequentially, tombstones are lossy (failures swallowed, 90-day prune), at-rest ciphertext is bound to the device's database name, BYOK keys sit in the `settings` row, and five ADRs state "one writer".

## Decision

### 1. An official account, optional

Cognia operates an account for ordinary users. Signing in is optional: "continue offline" stays, and a LocalProfile that never signs in behaves exactly as today. There is no billing or commercial capability.

The identity has three layers, one job each:

| Layer | Id | Job |
| ----- | -- | --- |
| Person | `usr_…` | Owns the sync space and the device directory. |
| Device | `dev_…` | Holds a P-256 signing key and a P-256 encryption key, distinct from its companion pairing key. |
| LocalProfile | `acct_…` | Stays the local unlock and at-rest encryption boundary. |

On one device a Person binds to at most one LocalProfile, and a LocalProfile to at most one Person (the existing `userBindings` rule). Separating work and personal means two accounts.

### 2. Identity runs on Workers and speaks only OIDC

- The official issuer is **Better Auth on Workers + D1** (`id.cognia.cn`) with the OAuth 2.1 Provider and JWT plugins, explicit JWKS rotation, on Workers Paid. Its `sub` is the `usr_` id.
- Cognia apps are public PKCE clients. The callback generalizes to `cognia://auth/callback` (desktop, phone), loopback (CLI) and the SPA route (web).
- **Clients are issuer-agnostic.** `lib/identity/deployment-discovery.ts` gains the official issuer as its built-in default instead of waiting for a Host to announce multi-tenant mode. A self-host override points at any OIDC issuer; self-hosted Logto remains the reference implementation and is used in development to prove the client is issuer-agnostic.
- Rust verifiers converge on `cognia-tenant-auth::oidc`; the companion gateway's own JWKS cache and the diagnostic server's static PEM become its consumers. A TypeScript port, checked against `crates/cognia-tenant-auth/fixtures/grant-wire-vector.json`, serves Workers.
- Social providers: Feishu/Lark through `genericOAuth` (authorize `accounts.feishu.cn/open-apis/authen/v1/authorize`, token **v2** `open.feishu.cn/open-apis/authen/v2/oauth/token`, userinfo unwrapped from `data`), keyed on `(feishu|lark, tenant_key, union_id)`, never `open_id`; GitHub and Google built in; Apple with a per-login ES256 client secret and the `form_post` cookie fix; WeChat on `unionid`. Email is optional. Login requests minimal scopes.
- Rejected: OpenAuth (stalled, OAuth-only, no `id_token`), `@cloudflare/workers-oauth-provider` (opaque tokens no Rust verifier can check), Auth.js and Lucia (not issuers, or deprecated), Logto as the official issuer (needs Postgres and Redis, cannot run on Workers).

### 3. Keys never leave devices unsealed

- Each epoch has a random 256-bit **sync key** `SK_e`. The server stores it only as HPKE envelopes: one per active device and one for a **recovery public key**.
- The **recovery key** is 128 random bits shown as grouped Crockford base32. It deterministically derives a P-256 key pair; only the public half is uploaded, so any device can seal a new epoch to recovery without knowing the recovery key.
- Each new epoch wraps the previous key, so the current key opens all history.
- **Rotation** on device revocation, on recovery-key regeneration, on recovery use, and on demand. A revoked device cannot read a new epoch even if the server is compromised; what it already cached cannot be recalled, and the UI says so.
- The first device must generate the recovery key and pass a confirmation (retype four positions or download the recovery kit) before anything uploads. Regenerating the key invalidates the old one at once.
- **Losing every device and the recovery key loses the data.** Enrollment says so plainly.
- Login never derives keys. OIDC authenticates transport only.
- Locally, the key chain is a vault secret under the LocalProfile master key. Because at-rest ciphertext is bound to the device's database name, sync decrypts locally and re-encrypts under `SK_e`; at-rest ciphertext is never shipped.
- This refines the design spec's single account master key: sealing epochs directly to devices and to a recovery public key gives real revocation without ever needing the recovery key to rotate.
- P-256 rather than Curve25519: it is the curve the repo already uses for ECDSA and ECDH in WebCrypto and Rust, and X25519 support in older Android WebViews is uncertain.

### 4. New devices are approved, or recovered

- A new device posts its public keys. Every signed-in device gets a notification showing the device and a six-digit code; the user confirms the codes match and approves, and the approver seals the current key to the new device. Requests expire after 15 minutes. The notification reuses the device console (`components/devices/`) and the notification system.
- Without another device at hand, the user types the recovery key; a recovery use rotates the epoch and offers to regenerate the recovery key.
- The device registry is a signature chain rooted at the pinned genesis device, so the server cannot inject a device.
- **A device that already has local data** previews the difference, takes an ADR-0001 backup, then merges (default) or discards its local data. Built-in seeded rows never duplicate: only the user's overlay on them syncs.

### 5. One Durable Object per account

- The account object stores the device registry, sealed epoch envelopes, the op log, the snapshot manifest, leases and counters. WebSocket hibernation; long-poll fallback.
- Per op it only authenticates the device session, verifies the signature against the registry (revoked devices are refused without reading content), dedupes by `(deviceId, deviceSeq)`, assigns a gapless `serverSeq` and notifies connected devices. One stored row per pushed batch.
- Ops carry a coarse cleartext class (content, settings, secrets, CRDT, append-only); table names, row ids, field names and values are inside padded ciphertext.
- Snapshots are made by the device holding the compaction lease, encrypted and chunked into R2; the object then drops old op batches.
- Blobs are client-encrypted and content-addressed by a keyed hash in R2.
- Self-host runs the same Worker under `workerd` with Durable Object storage on local disk and an S3-compatible blob store, packaged in `deploy/compose`. No second implementation of the server.

### 6. Every enrolled device is a writable replica; merge is on the client

- Record tables merge per field, last writer wins by `(HLC, deviceId)`. HLC generation refuses to advance more than five minutes past the local clock.
- Deletes are a field with its own clock. Tombstones are collected only after every active device has acknowledged past them; a device unseen for 90 days restarts from a snapshot.
- Messages are append-only; edits are new versions.
- Rich text and canvas carry Yjs updates as opaque encrypted ops.
- Schema evolution is additive. A client stores but does not apply ops from a newer schema, preserves fields it does not know and re-emits them untouched, and asks the user to update. The server enforces a minimum client version.
- Change capture is a DBCore middleware that writes an outbox row in the same IndexedDB transaction, beside `createEncryptedContentMiddleware` and `createMessageSyncRevisionMiddleware`. Remote ops are applied without re-capture.
- A **signed-in phone is a full replica**: it reads and writes with every host offline and downloads blobs on demand (optionally only on Wi-Fi). **Pure web** becomes a full replica in phase 6, holding its keys only in memory or as non-extractable WebCrypto keys, unlocked each visit by approval or recovery key.
- QR pairing and companion pull sync remain for remote control and for people who never sign in.

### 7. What syncs, by class

The table catalog gains a `DataSyncMode` value `account-e2e` beside `none` and `companion-readonly`; a gate pins every table's class. Every class is on by default and can be turned off per class; any secret can be marked "this device only".

| Class | Examples | Rule |
| ----- | -------- | ---- |
| Content | sessions, messages, characters, skills, memories, workflows, templates, plans, goals, issues, bots | op log, per-field merge; messages append-only |
| Settings | the single `settings` row | split into one row per key; each key classified by `settings-sync.ts` as shared, device-local or desktop-only |
| Secrets | provider API keys, bot app secrets, OAuth token sets | separate class; BYOK keys first move out of the plaintext `settings` row; rotating credentials refresh only under a lease |
| Execution | connector runtimes, scheduled tasks, live agent turns, terminals, sandboxes | configuration syncs; running needs a lease (§8) |
| Device-local | window state, local paths, stdio MCP commands, vector index | never synced; the vector index is rebuilt per device |
| Blobs | attachments, artifacts, images | encrypted, content-addressed objects in R2 |
| Plugins | installs | the intent syncs (`setPluginIntent`); each device reconciles |

New ids are UUIDv7 or CSPRNG nanoid. Human issue numbers come from a counter in the account object (a counter is metadata; E2E is unaffected).

### 8. Data replicates everywhere; execution runs in one place

- The account object grants leases `{resource, holder, generation, expiresAt}`: 30-second TTL, renewal every 10 seconds, monotonic generations that accompany every external effect so a stale holder is fenced. Resource names reach the server only as keyed hashes.
- Leased resources: each connector instance, each scheduled task, each live session turn, compaction, and each rotating credential's refresh.
- Placement is decided by clients: when a lease expires, devices retry in rank order (headless server, then the most recently active desktop, then other desktops), and a resource can be pinned to one device. Resources that depend on the machine (stdio MCP, local-path workspaces, computer use) are pinned to their creating device by default. A live agent turn never moves on its own; it moves only through the explicit handoff of ADR-0103.
- Phones and browsers never take execution leases.
- A host that cannot reach the account object stops a held resource when its lease would have expired and never grants itself one.
- This closes a gap that exists today regardless of sync: nothing stops two hosts configured with the same Feishu app from both connecting it.

### 9. Feishu login, IM bot and user authorization are three things

| | What | Credential | Owner |
| - | ---- | ---------- | ----- |
| Login identity | who you are | `union_id` + `tenant_key` | the Person |
| IM bot | the channel | the bot app's `app_id` / `app_secret` | connector configuration, secrets class |
| User authorization | docs, sending as you | `user_access_token` + single-use rotating `refresh_token` | one Feishu app, secrets class |

- A Feishu user token works only for the app that issued it; `union_id` matches only across apps from the same developer.
- **Bots are bring-your-own.** The user's own app runs on the user's host; message content never transits Cognia servers. A login can never supply a bot credential.
- **Login identity binds the bot's sender.** When the signed-in Feishu person messages a bring-your-own bot, the connector recognizes them by `lark:<tenant_key>:<union_id>`. This needs the fixes listed under Consequences.
- **User authorization is a separate consent**, prefilled with the signed-in account, requesting `offline_access` and the API scopes. Tokens are client-held and sync as secrets; refresh happens only under the credential's refresh lease, and the new token set is written immediately.
- Logto's built-in Feishu connector discards the provider token and keys on `open_id`; this design does not depend on it.
- The login app is a self-built Feishu app for now, which only its own tenant can use. Feishu ISV status and a marketplace app are required before public launch; the application runs in parallel with the work.

### 10. Sign-out, revocation, deletion, quotas

- **Sign-out** keeps local data and the unsent outbox; sync resumes only when the same Person signs in again. Signing in as a different Person on that LocalProfile is refused with a prompt to create a new profile. A separate "remove account data from this device" self-revokes and deletes the profile after a second confirmation.
- **Revoking a device** refuses its requests, closes its sockets and rotates the epoch. On its next contact it locks the profile and deletes its keys and secrets; its encrypted local content stays, readable only with the local password, and never syncs again. An opt-in "also wipe local data" checkbox deletes the profile instead.
- **Deleting the account** has a 7-day cooling-off period during which it can be cancelled; the user is offered a backup first. At the deadline the account object, its R2 prefix and the identity record are deleted, and devices keep their data as plain local profiles.
- **Quotas** (anti-abuse, tunable): op log plus snapshots 2 GB soft, blobs 10 GB soft. Above soft, blob uploads stop and text keeps syncing; above 125% of soft, only deletes are accepted. The client shows usage and a cleanup entry.

### 11. Out of scope here

- **The collaboration plane is unchanged.** The only promise is that the official issuer is standard OIDC, so the collab server can later accept it through `COLLAB_OIDC_ISSUER`. Better Auth's organization plugin stays off; two organization sources must not coexist. `host_bindings.tenant_id` keeps its UNIQUE constraint.
- Cloud auth convergence of the share, status and diagnostic services is a follow-up in the same family (see Consequences).

## Amended decisions

| ADR | Was | Now |
| --- | --- | --- |
| 0054 | no at-rest encryption; cloud identity and account sync out of scope | at-rest encryption exists; account sync is this ADR |
| 0097 D5 | per-field timestamps rejected as unneeded for one user | per-field HLC for `account-e2e` tables, because several hosts write |
| 0103 | two writable copies are never permitted | holds for a live session turn (a lease); data has many writable replicas |
| 0116 | the active host is the sole authority for a live session, with a 30 s lease | the authority is the lease holder in the account object; the lease and generation move there |
| 0136 | deliberately no inter-host authority negotiation | leases in the account object; deterministic idempotency stays as a second fence |
| 0149 §6 | group E2E rejected because the local database is not encrypted at rest | that premise is stale; personal sync is E2E; the org plane stays server-readable |

## Non-goals

- Billing, plans or paid storage.
- An official Cognia bot that relays IM traffic through Cognia's cloud.
- Server-side merge, search or any server feature that would need plaintext.
- Joining the official account to organizations.
- Recovering data when every device and the recovery key are lost.

## Consequences

- People get one account across desktops, phones and the web; a phone keeps working with every host offline; two desktops are both writable; scheduled tasks and bots run once.
- Cognia now operates user-facing infrastructure: an identity Worker with D1 and an account Durable Object with R2, on Workers Paid. At about 10,000 active users the estimate is $150–200 per month, dominated by DO and R2 storage; batching keeps row writes inside the included allowance.
- Preconditions before the first synced table: CSPRNG ids, per-key settings rows, BYOK keys out of `settings`, the issue counter in the account object, the outbox middleware, and the catalog's `account-e2e` class with its gate.
- Defects found during this design and fixed independently of it:
  1. The Feishu connector never records `union_id` (`LarkSenderId` in `lib/connectors/adapters/lark/parse.ts` has only `open_id`/`user_id`, and principal creation omits `unionId`), so login links and IM principals never match.
  2. Inbound principal resolution never reads `externalIdentities` (`lib/connectors/.../resolve.ts`).
  3. `logtoSubject` on Feishu principals is documented as filled on login but never written.
  4. `skills/built-in/lark/auth-bridge.ts` reads `settings.appId`, but `appId` lives only in the secret store.
  5. ADR-0091 says `larkPrincipalRegistry` defaults off; `lib/connectors/feature-flags.ts` has it on.
  6. On web and Capacitor the keyring key sits in `localStorage`, so tokens stored there are obfuscated, not protected; Capacitor should use secure storage.
  7. Claude subscription OAuth stays reachable from the add-account dialog although ADR-0010's review flags it.
  8. The diagnostic server's anonymous grant verifies against a key supplied in the same request; the tenant existence check needs confirming.
- Follow-up cloud auth convergence: share create and owner actions accept Person tokens and `SHARE_GRANT_KEY` gets set; status admin gets its Access configuration; signaling stays key-bound, with the device directory replacing QR pairing for signed-in devices.

## Risks

- **Mainland China reachability.** Cloudflare's standard network has no mainland presence; `*.workers.dev` is mostly unreachable and custom domains work with higher latency. Accepted: sync is background and latency-tolerant, the services use `*.cognia.cn` custom domains, and sockets fall back to long-polling. Login redirects are the most latency-sensitive step; self-hosting is the escape hatch.
- **Feishu reach.** Until a marketplace app exists, only the login app's own tenant can sign in with Feishu.
- **Unverified assumptions, each a spike before its phase:** Better Auth issues access tokens whose `aud` is the sync API and whose `sub` the Rust verifiers accept; `workerd` runs SQLite-backed Durable Objects on local disk for self-host; HPKE over P-256 performs acceptably in WebCrypto on the oldest supported Android WebView.
- **Recovery-key loss is unrecoverable.** Mitigated only by the mandatory confirmation and by device approval.

## Roadmap

1. **Identity.** Better Auth Worker and D1; Feishu (self-built), GitHub, Google, Apple; issuer-agnostic client with the official default; profile-to-Person binding; the Feishu defects above.
2. **Keys and enrollment.** Device keys, recovery key and confirmation, approval with the six-digit code, recovery, revocation, epoch rotation.
3. **Sync core.** Account object, op log, HLC, outbox middleware, snapshots, schema-skew handling, ids and counters. First tables: sessions, messages, characters, skills, memories, settings (split).
4. **Execution leases.** Connectors, scheduler, live turns; the amendments to 0103, 0116 and 0136 take effect.
5. **Secrets and Feishu user authorization.** Secrets class, refresh leases, BYOK keys out of `settings`.
6. **Remaining tables and blobs**, phone as a full replica, pure web as a full replica.
7. **Cloud auth convergence** and the marketplace app swap.

## Verification

- Protocol vectors in `packages/sync-protocol/fixtures/` (canonical encoding, signatures, HPKE seals, padding, HLC merge) pass in the client and the Worker.
- Merge properties: two replicas applying the same ops in any order converge (property tests over random op interleavings, including deletes, skewed clocks and newer-schema ops).
- Revocation: after revoking a device, an envelope for the new epoch never exists for it, and its requests are refused.
- Leases: two hosts configured with the same connector never both run it; a holder that loses the account object stops at expiry.
- The issuer-agnostic client signs in against both local Logto and the Better Auth Worker without code changes.
- Each phase ships co-located tests, en/zh-CN strings and a changeset per the repository rules.
