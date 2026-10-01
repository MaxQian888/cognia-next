# Collaboration and multi-device communication: gaps against mature designs

**Date:** 2026-09-30
**Status:** Research complete. The P1 items have Proposed ADRs: [0206](../content/docs/en/adr/0206-a-workspace-streams-its-changes-instead-of-being-polled.md), [0207](../content/docs/en/adr/0207-a-collaboration-event-reaches-people-who-are-not-in-the-room.md), [0208](../content/docs/en/adr/0208-edits-to-different-fields-merge.md), and an [ADR-0158 amendment](../content/docs/en/adr/0158-artifacts-and-canvas.md). Nothing is implemented yet.
**Scope:** Two things. First, working together between people (the collaboration plane, ADR-0149). Second, communication between one person's devices (the companion plane, ADR-0021/0027/0170). The public share links (ADR-0037) and terminal sharing (ADR-0133) are covered where they overlap.

## How this document was produced

1. **Mapped the system.** Three read-only sweeps covered the collaboration plane, the companion transport and sync path, and the twelve related ADRs.
2. **Checked for counter-evidence.** Where the sweeps disagreed with each other or with the docs, the code settled it. Examples: Yjs versus the documented vector clock, suspend/resume wiring, and whether pairing already raises an alert. Every gap below cites the file that confirms it.
3. **Compared with shipped designs.** Each concern was set against a production design that solves it: Linear, Replicache/Zero, Figma, Hocuspocus/Y-Sweet, Tailscale/iroh, Signal multi-device, Apple Handoff and Home Assistant push.

**Headline finding:** the individual pieces are strong. Examples:

- E2E-encrypted signaling
- a durable outbound queue with a 24h idempotency ledger
- a two-phase session handoff
- server-authoritative shared chat with a run lease
- Yjs canvas co-editing

What is missing is **shared infrastructure between the planes**. Cognia runs four sharing planes, and each has its own transport, principal, freshness model and presence. Every mature product surveyed runs **one** event backbone, and presence and notifications ride on it. The largest gaps come from that fragmentation:

- team data is polled every 60 seconds;
- a mention or assignment reaches nobody who is not in the room;
- presence is implemented three times.

---

## 1. The system today

| Plane                                | Principal                                                                     | Source of truth                                              | Transport                                                         | Freshness                                                                                                       | Conflicts                                                                                                                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Companion** (one person's devices) | Device, ES256 key (`crates/cognia-companion-security/src/security_store.rs`)  | Host Dexie (desktop or headless)                             | LAN HTTPS/WS → cloudflared → WebRTC DataChannel → relay data lane | Event plane `/ws/v1/events`: global seq, ack, 24h / 10k-frame window, then `resync_required`                    | Host wins (`lib/sync/handlers/base.ts` `bulkPut`). The outbox moves to `conflicted` on a `baseRevision` mismatch. HostState orders by `{hostGeneration, hostSeq}` |
| **Collab server** (people)           | Logto `usr_` + Org/Workspace roles (`crates/cognia-tenant-auth/src/roles.rs`) | Postgres with RLS (`crates/cognia-collab-server`)            | HTTP. WS only for shared chat `/stream` and canvas                | Issues, plans and runs are **polled every 60s** (`lib/collab/refresh-scheduler.ts`). Chat is a seq event stream | `operationId` + `baseRevision` → **whole-record 409**, which the user resolves (`components/issues/collab-conflicts-panel.tsx`)                                   |
| **Terminal share**                   | Paired-device grant `terminal.open`                                           | Host in-memory roster (`crates/cognia-terminal/src/host.rs`) | Companion WS                                                      | Live                                                                                                            | One controller lease plus viewers                                                                                                                                 |
| **Share links**                      | Anonymous; the key sits in the URL `#fragment`                                | Blind store (`services/share-server/`)                       | HTTP                                                              | None (a one-way publish)                                                                                        | n/a                                                                                                                                                               |

### Strengths to keep

- **Signaling rooms are E2E-encrypted.** P-256 ECDH + HKDF + AES-256-GCM, ECDSA-signed frames and a replay window (ADR-0021).
- **Device writes are durable and idempotent.** The outbound queue (`lib/queue/outbound-queue.ts`) has statuses `pending → sending → sent | deadlettered | rejected | conflicted`. The server keeps a 24h `(deviceId, method, idempotencyKey)` ledger.
- **Cursors are paged, and messages have a monotonic clock** (`hostSyncCursors`, `messageSyncClock`). A fence stops a stale pull from writing into a newly selected Host's database.
- **A session never has two writable copies.** Handoff is a two-phase ticket, `thread-handoff-v1`.
- **One phone can pair with several Hosts.** Each has its own database and cursor namespace (`lib/companion/credential-book/`).
- **Shared chat is server-authoritative.**
  - Every session has an ordered event log.
  - Agent execution runs under a run lease with a FIFO queue, and high-risk tools need an approver (`lib/collab/shared-run-coordinator.ts`, `shared-approval-bridge.ts`).
- **Canvas co-editing uses Yjs.** It shows awareness cursors, the server stores opaque updates, and every WS frame is re-authorized (`lib/canvas/collaboration/`, `crates/cognia-collab-server/src/canvas_api.rs`).
- **Membership administration** covers invitations, role changes, offboarding and an audit log (`components/workspace/workspace-*`, `lib/collab/membership-admin.ts`).

---

## 2. Verified gaps

### A. Working together

| #   | Gap                                                                                                                                                                                                                                                                                                                                                                | Evidence                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | **Both real-time features are off by default.**                                                                                                                                                                                                                                                                                                                    | Shared chat needs `COLLAB_SHARED_CHAT_ENABLED` (`crates/cognia-collab-server/src/main.rs:58`), plus `NEXT_PUBLIC_SHARED_CHAT_ENABLED` and a per-machine switch (`lib/collab/shared-chat-feature.ts`). Canvas needs `COLLAB_CANVAS_ENABLED` (`main.rs:61`) and `collaboration.enabled: false` (`types/canvas/settings.ts:213`) |
| A2  | **Issues, plans and runs are polled.** They refresh on boot, focus, coming online or becoming visible, and every 60s while visible, with backoff to 15 min. The server has no push path for them.                                                                                                                                                                  | `lib/collab/refresh-scheduler.ts`, `lib/collab/refresh.ts`                                                                                                                                                                                                                                                                    |
| A3  | **No notification reaches another person.** A mention, an assignment, an approval request or an invitation reaches only someone who has that room open right now. ADR-0149 calls this "a second-cut question".                                                                                                                                                     | The collab server has no notification table or route. `lib/notifications/` has no collab source                                                                                                                                                                                                                               |
| A4  | **A conflict covers the whole record.** Any `baseRevision` mismatch returns 409, even when two people changed different fields. `PatchIssueBody` is already partial.                                                                                                                                                                                               | `mutation_guard`, `crates/cognia-collab-server/src/api.rs:575`; `patch_issue`, `api.rs:1916`                                                                                                                                                                                                                                  |
| A5  | **Canvas is half-wired.** Seven client methods have no production caller: `listCanvasComments`, `createCanvasComment`, `listCanvasVersions`, `createCanvasVersion`, `readCanvasPresence`, `pushCanvasSnapshot`, `pullCanvasUpdates`. The offline replay queue lives only in memory. Compaction is never triggered. Comments still live in local `contextComments`. | `lib/collab/client.ts`; ADR-0158 "deliberately still open"                                                                                                                                                                                                                                                                    |
| A6  | **Shared chat lacks the human layer.** It has no human presence, no human `@mention`, no per-person approval and no team-room sharing. Execution stays on the laptop that started it, and nothing takes over.                                                                                                                                                      | ADR-0177 "Later"; ADR-0149                                                                                                                                                                                                                                                                                                    |
| A7  | **Large parts of the product are not collaborative at all.** This covers workflows, memory, wiki/knowledge, projects, Agent Team, Twin, Goals and artifacts outside canvas.                                                                                                                                                                                        | No `lib/collab` reference under `lib/{workflow,memory,wiki,project,twin,goal,artifacts}`                                                                                                                                                                                                                                      |
| A8  | **The server writes no `external_identities` rows for GitHub or Feishu.**                                                                                                                                                                                                                                                                                          | ADR-0149 acknowledged gaps                                                                                                                                                                                                                                                                                                    |
| A9  | ~~The RLS test does not run by default.~~ **Withdrawn on re-check:** the `postgres-rls` job in `.github/workflows/test.yml` runs the `#[ignore]` tests against a Postgres 17 service whenever `crates/cognia-collab-server/` or `crates/cognia-tenant-auth/` changes (`scripts/test/coverage-changed.mjs`).                                                        | `.github/workflows/test.yml:1611`                                                                                                                                                                                                                                                                                             |

### B. One person's devices

| #   | Gap                                                                                                                                                                                                                                                                                                                          | Evidence                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| B1  | **Every device depends on one Host.** When the Host is off, the phone serves its read-only mirror and queues writes. Two laptops replicate nothing to each other. A room holds one desktop and one mobile.                                                                                                                   | `lib/sync/types.ts`; `SIGNALING_MAX_PEERS_PER_ROOM=2`, `SIGNALING_MAX_DESKTOPS=1`                                  |
| B2  | **Some user deletions never reach the phone. This is a correctness bug.** `deleteSkill` (`lib/db/skills.ts:182`), and the deletes in `lib/db/{memories,mcp-servers,plugins,template-platform}.ts`, call no `recordTombstones`. Their registry rows say `has_tombstones: false`, so the phone keeps the deleted row for good. | `crates/cognia-companion-bus/src/sync_registry.rs`; `lib/sync/tombstones.ts`                                       |
| B3  | **About 48 of ~373 tables sync.** Artifacts, canvas, knowledge bases, drafts, media, provider profiles and prompt presets do not.                                                                                                                                                                                            | `COMPANION_SYNC_PROTOCOL_TABLE_NAMES` in `lib/data-governance/table-catalog.ts`                                    |
| B4  | **The relay data lane has frame and rate caps but no byte quota. There is also no hosted TURN, and STUN is hardcoded.**                                                                                                                                                                                                      | `services/signaling-server/core/src/limits.rs`; ADR-0170 non-goals; `lib/signaling/{desktop,mobile}-controller.ts` |
| B5  | **No device key can be rotated or expire.** Rotating means pairing again. The HS256 secret `store` is dead code.                                                                                                                                                                                                             | No rotation API anywhere; `crates/cognia-companion-security/src/secret.rs:48` `#[allow(dead_code)]`                |
| B6  | **A new pairing raises no alert.** `companion://device-paired` already reaches every client (`ChannelAudience::Any`, default on), but `lib/companion/event-bridge.ts` only mirrors it into `pairedDevices`. No `notify()` call follows, so nobody is told.                                                                   | `crates/cognia-companion/src/api.rs:1524`; `crates/cognia-companion-bus/src/event_channels.rs:246`                 |
| B7  | **Push needs your own APNs/FCM credentials.** There is no Web Push and no mobile background refresh (BGTask/WorkManager).                                                                                                                                                                                                    | `crates/cognia-companion-bus/src/push_creds.rs`; ADR-0027                                                          |
| B8  | **Presence is in memory and does not survive a reload. It is also implemented three times:** devices, shared chat and canvas. `presenceLabel`/`devicePresence` are dormant.                                                                                                                                                  | `lib/companion/device-presence-registry.ts`; ADR-0143                                                              |
| B9  | **The device proof is shaped like DPoP but is not RFC 9449.** It has no `jwk` header, and `htu` is a bare path.                                                                                                                                                                                                              | `packages/companion-client/src/dpop.ts`                                                                            |

### C. Documentation drift

- **`docs/content/docs/{en,zh}/subsystems/canvas/collaboration.mdx` describes a vector-clock CRDT.** The code uses **Yjs** (`yjs ^13.6.33`, `lib/canvas/collaboration/crdt-store.ts`).
- **`docs/content/docs/{en,zh}/data/sync-system.mdx` "Known Limitations" is out of date.** It says the cursor lives in memory, there are no tombstones, the phone is read-only and 200 messages are fetched. All four are false today.
- **ADR-0143 says `companion_suspend_device` / `companion_resume_device` are unused.** The device console calls them through `hooks/devices/use-device-grant-actions.ts` → `lib/devices/lifecycle-http.ts`.
- **The header of `lib/issues/sources/collab-source.ts` still says "read-only".** That predates the 2026-08-28 write path.

---

## 3. Against mature designs

| Concern            | Cognia                                               | Reference design                                                                                                                                                               | What to take                                                                                                                                                                                                                                    |
| ------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sync engine**    | Per-table cursors; each table opts into tombstones   | **Linear**: one server-ordered transaction log (`lastSyncId`), with deletes as log entries. **Replicache/Zero**: push mutations, pull patches, `lastMutationID`, server rebase | Make delete propagation structural. Every synced table declares its delete strategy, enforced by a gate                                                                                                                                         |
| **Team freshness** | 60s polling                                          | **Linear, Figma, Notion**: one WS delta feed per workspace                                                                                                                     | A workspace change feed carrying invalidations only, on a hub shared with chat and canvas → [ADR-0206](../content/docs/en/adr/0206-a-workspace-streams-its-changes-instead-of-being-polled.md)                                                  |
| **Conflicts**      | Whole-record 409                                     | **Figma, Linear**: per-property last-writer-wins in server order                                                                                                               | Per-field revisions; 409 only when the same field changed → [ADR-0208](../content/docs/en/adr/0208-edits-to-different-fields-merge.md)                                                                                                          |
| **Notifications**  | None between people                                  | **Linear Inbox, GitHub, Slack**: a durable per-recipient inbox fanned out to push and email                                                                                    | Server rows per recipient, fed into the existing ADR-0042 `notify()` pipe, which already reaches push and **IM** → [ADR-0207](../content/docs/en/adr/0207-a-collaboration-event-reaches-people-who-are-not-in-the-room.md)                      |
| **CRDT documents** | Yjs; replay queue in memory; no compaction ever runs | **Hocuspocus, Y-Sweet, Liveblocks**: IndexedDB persistence plus a snapshot policy that bounds the update log                                                                   | Persist the queue into Dexie. Add a trigger for the maintainer-side compaction that ADR-0158 already chose, which keeps `yrs` out of the server as that ADR decided → [ADR-0158 amendment](../content/docs/en/adr/0158-artifacts-and-canvas.md) |
| **Presence**       | Three in-memory copies                               | **Phoenix Presence, Liveblocks**: one ephemeral channel with a heartbeat TTL                                                                                                   | One presence model shared by devices, chat and canvas                                                                                                                                                                                           |
| **Relay**          | STUN, a relay lane with no quota, BYO TURN           | **Tailscale DERP, iroh**: an always-on relay, an upgrade to a direct path, per-node quotas                                                                                     | A byte quota before any public relay. Check ICE restart on Wi-Fi ↔ cellular                                                                                                                                                                     |
| **Host offline**   | The phone waits                                      | **Signal server, CloudKit**: an encrypted store-and-forward mailbox                                                                                                            | An optional mailbox on the rendezvous, sealed with the room keys, drained when the Host returns                                                                                                                                                 |
| **Device trust**   | ES256 keys and revoke; no rotation or expiry         | **Signal/WhatsApp multi-device, Matrix cross-signing, Tailscale key expiry**                                                                                                   | Rotation with an overlap window, optional expiry, and a "new device paired" alert on every other device                                                                                                                                         |
| **Push**           | Your own APNs/FCM credentials                        | **Home Assistant, ntfy, UnifiedPush**: a hosted relay with opaque payloads                                                                                                     | An optional relay; the payloads already carry ids only. Mobile background refresh                                                                                                                                                               |
| **Continuity**     | A two-phase handoff ticket                           | **Apple Handoff**: an ambient "continue here" suggestion                                                                                                                       | Suggest a handoff when a paired device becomes active                                                                                                                                                                                           |
| **Terminal share** | A device-wide grant, paired devices only             | **VS Code Live Share, tmate, Warp**: per-session, per-person, read-only by default                                                                                             | A per-session ticket scoped to a collab `User` (the place ADR-0133 names)                                                                                                                                                                       |

Cognia has one advantage the references lack: **IM connectors**. A mention can reach someone in Feishu or Lark through the same `lib/notifications/im-deliver.ts` path the scheduler already uses. No reference product delivers there natively.

---

## 4. Roadmap

### P0: correctness and hygiene (small, low risk; no ADR needed)

1. **Tombstones for every synced table a user can delete from** (B2).
   - Record tombstones in the delete paths of `skills`, `memories`, `mcpServers`, `plugins` and the template tables.
   - Flip their `has_tombstones`.
   - Add a gate test: every entry in `COMPANION_SYNC_PROTOCOL_TABLE_NAMES` must declare `tombstoned`, `append-only` or `retention-pruned`.
2. **A "new device paired" alert** (B6). Route `companion://device-paired` through `notify()` in `lib/companion/event-bridge.ts`. Every other client and the desktop then see it through the existing channels, including push.
3. **A byte quota and metering on the relay data lane** (B4), in `services/signaling-server/core/src/limits.rs`, shared by the Worker and axum builds.
4. **The documentation drift fixes** (C).
5. ~~Run the Postgres RLS test in CI (A9).~~ Already in place; withdrawn.

### P1: real-time collaboration (Proposed ADRs)

6. **ADR-0206: a workspace streams its changes instead of being polled** (A2).
7. **ADR-0207: a collaboration event reaches people who are not in the room** (A3).
8. **ADR-0208: edits to different fields merge; only an edit to the same field conflicts** (A4).
9. **ADR-0158 amendment: Canvas collaboration is finished before it defaults on** (A5, A1).

### P2: resilience across devices

10. **An encrypted store-and-forward mailbox** on the rendezvous for writes queued while the Host is offline (B1). This amends ADR-0170.
11. **Device-key rotation with overlap, plus optional expiry** (B5).
12. **One presence service** for `/devices`, shared chat and canvas that survives a reload (B8).
13. **Mobile background refresh, plus an optional hosted push relay** (B7).

### P3: more of the product becomes shareable

14. **Explicit publish, using the plan pattern** in `lib/collab/publish.ts`, for knowledge base and wiki pages and for workflow templates (A7).
15. **A cloud executor for shared runs** on the ADR-0182 sandbox pool, so a shared run is not tied to one laptop (A6).
16. **Per-person, per-session terminal share tickets.**
17. **Human presence and `@mention` in shared chat** (A6). This depends on 0207 and item 12.

## 5. Implementation status (2026-10-01)

**P0: done.**

- **1. Tombstones:**
  - Every user-deletable synced table now records tombstones in its delete paths.
  - `has_tombstones` is set for those tables in `crates/cognia-companion-bus/src/sync_registry.rs`.
  - `COMPANION_SYNC_DELETE_STRATEGY` in `lib/data-governance/table-catalog.ts` declares a strategy for every synced table (50 today). `scripts/gates/check-data-governance.mjs` checks it against the Rust flags.
- **2. Pairing alert:** `announceDevicePaired` in `lib/companion/event-bridge.ts`.
- **3. Relay quota:**
  - `RelayByteQuota` in `services/signaling-server/core/src/limits.rs`, enforced by both the axum and Worker builds.
  - Clients pause relayed data until the window resets (`lib/tauri/transport-rtc.ts`, `crates/cognia-companion-connectivity`).
- **4. Documentation drift:** fixed in the sync-system and canvas collaboration pages and in ADR-0143.

**P1:**

- **ADR-0206: accepted and implemented.** One feed per organisation drives the refresh scheduler. Chat, Canvas and the feed share `socket_hub.rs`.
- **ADR-0208: accepted and implemented.** `field_revisions` (migration 0012) and `field_merge.rs`; the conflicts panel shows the clash per field.
- **ADR-0207: accepted and implemented.**
  - Server:
    - `notifications.rs` and migration 0013;
    - producers for assignment, declared mentions, high-risk approval requests and targeted shared-chat invites;
    - a new route to accept a targeted invite by id.
  - Client: a cursor-pulled sync into `notify()` under source `collab`, with read state flowing both ways.
- **ADR-0158 amendment: still open.** It covers the durable replay queue, compaction, comments and versions on the plane, and the default flip. It is owned separately.

The Postgres tests in `crates/cognia-collab-server/tests/postgres_rls.rs` cover:

- field-merge;
- notification ordering and dedupe;
- targeted-invite acceptance.

They pass against Postgres 17 and run in the `postgres-rls` CI job.

**P2 and P3: not started.**

## Non-goals carried forward

These stay out of scope for the reasons their ADRs give:

- group end-to-end encryption on the collaboration plane (ADR-0149);
- public self-serve sign-up (ADR-0149);
- adding `userId` to local Dexie tables (ADR-0149);
- desktop ↔ desktop data replication, as opposed to driving a remote Host (ADR-0136, no inter-host authority);
- hosted TURN (ADR-0170).
