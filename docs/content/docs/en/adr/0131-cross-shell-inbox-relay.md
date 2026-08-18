---
title: ADR-0131 — Cross-shell inbox relay
description: One shell-agnostic write path for every Inbox action — manual replies, draft approvals, and conversation overrides — so a phone, a browser, or a desktop driving a remote host can act on platform conversations the way the machine running the bots always could, with end-to-end idempotency and a notifiable push that carries ids, never message text.
---

# ADR-0131 — Cross-shell inbox relay

| Field     | Value                                                                                                                                                                                                                                                                                                            |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status    | Accepted                                                                                                                                                                                                                                                                                                         |
| Date      | 2026-08-18                                                                                                                                                                                                                                                                                                       |
| Builds on | ADR-0009 — Platform connectors; ADR-0025 — Unified subscription / adapter runtime; ADR-0027 — Mobile sync orchestrator; ADR-0036 — Adapter method matrix; ADR-0059 — Host profiles and capability gates; ADR-0060 — Device identity on the companion plane; ADR-0082 — Desktop driving a remote host; ADR-0089 — Outbound delivery semantics |
| Scope     | `lib/connectors/inbox-writes/**`, `lib/connectors/inbox-relay/`, `lib/connectors/inbound-notifiability.ts`, `lib/sync/host-invalidate.ts`, `lib/sync/handlers/{connector-drafts,outbound-queue,conversation-overrides}.ts`, `lib/companion/{host-event-publisher,desktop-write-source}.ts`, `lib/db/schema.ts` (v173), `protocol/companion-*.json`, `src-tauri/src/companion_api/{rpc,rpc/data_sync,rpc/service_plane,event_channels,commands,ws_bridge}.rs`, every Inbox write surface under `components/inbox/`, `components/chat/composer.tsx`, `hooks/use-draft-approval.ts` |

## Context

The Inbox was only ever fully usable on the machine that ran the connector adapters. An audit of the three shells found the gap was not one missing feature but a missing *seam*: every reply surface decided for itself how to write, and only one of those decisions worked.

- **A phone's reply was silently discarded.** `components/mobile/connector/draft-approval-panel.tsx` enqueued `connector_approve_draft` rows into `mobileOutboundQueue`, and the desktop arm they reached only flipped the draft's status — no outbound job, so nothing was ever delivered. The operator saw "approved" and the customer saw nothing.
- **`connector_send` did not send.** Despite the name, its host arm appended a local `user` message row and returned. It was the share-target's text-injection path, never a delivery path, and no RPC in the manifest actually enqueued outbound.
- **Overrides written from a thin client were clobbered.** A phone flipping conversation mode wrote its local `conversationOverrides` mirror; the next `sync_pull` handed back the host's pre-change row and overwrote it. The pill flipped, flipped back, then flipped again.
- **A browser could reach the Inbox but do nothing in it.** No adapter runs in a browser, so every control was inert — while the UI rendered an ordinary empty conversation list, which reads as "you have no conversations" rather than "this device cannot see them".
- **A desktop driving a remote host read the wrong database.** `isRemoteHostActive()` re-routed RPC traffic but not Dexie, so the Inbox rendered the local mirror of a host nobody was talking to.
- **There was no realtime signal at all.** `sync://invalidate` had exactly one publisher (a Tauri `emit`, so the headless brain published nothing), and the `claude://message-added` push trigger had no emitter. A paired phone learned about an inbound message only when it next came to the foreground.
- **Each surface re-derived routing.** Nine override controls, two draft reviewers, and the composer each imported Dexie primitives directly. Adding a shell meant editing twelve call sites, and each of them had to get idempotency right on its own.

## Decision

### 1. One write seam — `lib/connectors/inbox-writes/`

Components no longer branch on the shell. They call one of four functions — `sendManualReply`, `approveInboxDraft`, `rejectInboxDraft`, `mutateConversationOverride` — and `resolveInboxWriteRoute()` picks the executor:

| Route           | When                                                                              | Executes                                                             |
| --------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `"remote"`      | this desktop is driving a remote host (`isRemoteHostActive()`)                     | durable `mobileOutboundQueue` → RPC on the paired host                |
| `"local"`       | this shell owns a connector runtime (`hasCapability("connector-runtime")`)          | `local.ts`, against this process's Dexie and delivery gateway         |
| `"remote"`      | a companion target is active (paired phone, web companion)                          | durable queue → RPC                                                   |
| `"unavailable"` | standalone browser / unpaired phone                                                 | throws `InboxWriteUnavailableError`; the UI shows `RequiresHost`       |

Order matters: a desktop driving a remote host still advertises `connector-runtime` from its baseline, but its local runtime is torn down while the remote is active, so `"remote"` must win — otherwise the reply becomes an outbound job no running adapter would ever deliver.

`local.ts` holds the three primitives, lifted verbatim out of the composer. The **host RPC arms call the same functions**, so a phone-originated reply and a desktop-originated reply produce byte-identical `outboundQueue` and `messages` rows. There is no second implementation to drift.

### 2. Idempotency is end to end, not per hop

The client mints **one** `crypto.randomUUID()` per write and threads it through every layer: the `mobileOutboundQueue` row's `idempotencyKey`, the `Idempotency-Key` header the Rust ledger dedupes on, and `OutboundRequest.metadata.idempotencyKey` the outbound runner dedupes on. The host arm looks the key up in `outboundQueue` before enqueuing and returns the existing job on a hit.

Draft approvals derive their key from the draft id (`cdr-approve:<id>`) rather than minting one, so even a client that lost its queue row cannot produce a second outbound job for the same draft.

`sendManualReplyLocally` also handles the crash window between "job enqueued" and "message written": a replay that finds the job but not the message finishes the message rather than sending again.

### 3. Overrides travel as one serialisable mutation

`ConversationOverrideMutation` is a ten-arm union (`upsert`, `patch`, `configSection`, `setStatus`, `setAssignee`, `addLabel`, `removeLabel`, `setPinned`, `setArchived`, `delete`). The same value is:

- applied on the host by `applyConversationOverrideMutation`, which dispatches to the **existing** `lib/db/conversation-overrides.ts` primitives so audit rows and the assignment trail keep their exact semantics; and
- mirrored on the client by `applyOptimisticOverrideMutation`, which writes **only the named fields** — no audit, no trail. The host is authoritative and syncs back.

`setPinned` / `setArchived` / `delete` address rows by `conversationKey` even though the legacy primitives take a row id: a thin client only knows the key, and the key is the unique index.

The clobbering problem is closed by `pending-overrides.ts`: a conversation key with an in-flight mutation is skipped by the sync handler. It reads from two sources — an in-memory refcount covering the window before the queue row is persisted, and the durable queue itself for everything after, which is what survives a reload.

`callerDeviceId` is injected server-side by the Rust layer from the verified device context and becomes `via: "device:<id>"` on the assignment trail, so a phone-originated reassignment stays attributable.

### 4. Two realtime signals, deliberately distinct

`sync://invalidate` says *"table X changed, re-pull it"*. It is table-scoped, always sent, and coalesced 150 ms on the host (`lib/sync/host-invalidate.ts`) plus 100 ms per table on the client. `conversationKey` rides along only when every write in the window targeted the same conversation; a mixed burst drops it so the client does one table-wide pull instead of N keyed ones. It is skipped entirely while this desktop is itself a thin client — its rows are mirrors, not authority.

`connector://message-added` is the **notifiable** signal: one frame per inbound human message, carrying ids and a `/inbox/c?key=…` deep link. Rust registers a push trigger on it, so a phone whose WebSocket is closed still gets a lock-screen notification.

Three things are deliberately absent from that frame:

- **Message text.** It transits APNs/FCM. The Rust body builder names the sender and the platform; the text is fetched over the authenticated sync once the app opens.
- **Non-human events.** Edits, deletes, reactions and the bot's own outbound echoes are filtered by `isNotifiableInboundEvent`, extracted from `lib/notifications/inbound-connector.ts` so the relay and the desktop Notification Center can never disagree about what counts as a new message.
- **Duplicate wake-ups.** Suppressed when the operator is already viewing the conversation, when it is muted, or inside quiet hours — resolved with the same precedence the outbound runner uses.

The headless brain has no Tauri runtime, so `lib/companion/host-event-publisher.ts` gives both hosts one call: a registered publisher (brain, piping through `companion_event_publish`) → Tauri `emit` (desktop) → no-op. `ws_bridge.rs` validates the topic against a **closed allowlist** before publishing; the bridge peer is authenticated but letting it name arbitrary topics would let a compromised brain forge frames clients treat as authoritative.

### 5. Protocol and sync surface

`connector_enqueue_outbound` is new (target `execution`, idempotency required) and is the command `connector_send` was mistaken for; `connector_send` keeps its documented, narrower meaning. `connectors_discord_upload` and `connectors_onebot_probe` move from the client plane to the service plane so a headless brain can execute them — deliberately **without** a headless host gate, since both are pure functions needing no `AppHandle`, and a gate would add a class-C host-parity entry to a baseline that may only shrink.

Dexie **v173** adds an indexed `updatedAt` to `outboundQueue` and `connectorDrafts` (backfilled from `createdAt`) so both join companion sync, which is an `updatedAt`-cursor delta. `outboundQueue` is synced as a **projection** with `syncedFromHost: true` rather than a new table, so the existing readers (`use-outbound-saturation`, `OutboundStatusPill`) work unchanged; `listDueNow` / `pickNextDue` / `recoverStaleSendingJobs` filter those rows out so a local runner never dispatches a mirror.

### 6. Handoff is a first-class state

Losing the runtime lease is distinct from unmounting and from deferring to a remote host. `installConnectorRuntime` takes a teardown reason; on `"lease-lost"` it reclaims in-flight inbound jobs immediately (`reclaimAllRunning: true`) so they surface as `recovery_required` instead of sitting "running" with nothing running them, and it notifies `onRuntimeReleased`. `ConnectorBusProvider` re-acquires on a 30 s → 5 min backoff, checking `isRemoteHostActive()` each time.

Relayed writes that reach a process which no longer owns the runtime throw `connector_runtime_not_owner`. The wording is load-bearing: `lib/queue/retry-policy.ts` classifies it as **retryable**, so the phone's durable queue replays across the handoff window (5 attempts ≈ 31 s) instead of dead-lettering the reply.

### 7. Standalone shells explain themselves

A standalone browser tab or unpaired phone can read the Inbox but never write to it. This is permanent, not a gap, so it is documented on all three axes CLAUDE.md rule 7 requires: the surface contract is `standalone: "explain"` with `standaloneInboxRequiresHost` carrying the reason, `StateCard.RequiresHost` renders it and points at `/pair`, and both are pinned by tests.

## Non-goals

- **AI triage of inbound messages.** Routing stays rule- and assignment-driven.
- **Handing a conversation to another bot or a third-party agent.**
- **Outbound media on personal WeChat.**
- **A `configSchema`-driven settings renderer.**
- **A per-adapter Python-connector toggle.**

## Consequences

- Adding a shell is now a routing question, not twelve call sites. A new surface calls the facade and inherits idempotency, availability gating, and the optimistic mirror.
- The host arms and the desktop UI cannot drift, because they are the same functions.
- A phone reply survives airplane mode, a dropped socket, and a lease handoff without duplicating on the platform.
- Push fan-out is `AppHandle`-bound, so a **headless-only** deployment reaches foreground WebSocket clients but not lock screens. Documented rather than worked around; closing it needs a push path that does not go through Tauri.
- `outboundQueue` rows now exist that the local runner must never dispatch. The `syncedFromHost` filter is load-bearing and is enforced in three query paths plus a per-target database.

## References

- Slice plan: `~/.claude/plans/im-mattpocock-skills-grill-me-shimmying-naur.md`
- ADR-0009 (delivery ambiguity contract), ADR-0036 (adapter method matrix), ADR-0082 (remote host activation), ADR-0089 (reply quoting and follow-up bubbles)
