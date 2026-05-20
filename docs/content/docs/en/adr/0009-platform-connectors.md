---
title: "0009 — Platform Connectors"
description: "cognia-next gains a multi-platform messaging adapter layer so AI characters can receive inbound messages from Telegram, Discord, Slack, Lark, and OneBot and send replies via a robust FIFO outbound queue."
---

# ADR 0009 — Platform Connectors

**Status:** Accepted  
**Date:** 2026-05-05  
**Branch:** `feat/platform-connectors-phase1`

---

## Context

cognia-next has a mature AI chat engine, a rich character/skill system, and an employee digital
twin that can approximate a person's writing style. Until this ADR, none of that machinery could
interact with real messaging platforms — users had to copy-paste content manually.

The goal of Platform Connectors is to make a cognia-next AI character an _actual bot_ on
Telegram, Discord, Slack, Lark (Feishu), and QQ/NapCat (OneBot v11), with:

- Three operating modes: **auto** (AI replies without review), **manual** (human types the
  reply text), **draft** (AI generates a draft, human approves before sending).
- A reliable outbound queue with exponential back-off, per-adapter circuit breakers, rate
  limiters, idempotency dedup, and FIFO per-conversation ordering.
- A simple audit log for every inbound and outbound event.
- A plugin extension API so third-party platforms can be added without patching cognia-next.

---

## Decision

### Architecture overview

```
Messaging platforms
  ↓  (HTTP / WS / reverse-WS)
Tauri Rust layer (axum)
  ↓  (Tauri commands / invoke)
TypeScript layer (renderer)
  ├── ConnectorBus         — fan-in (inbound) + fan-out (outbound registry)
  ├── Policy evaluator     — TriggerPolicy rules + blockers → route decision
  ├── Mode router          — auto / manual / draft branching
  ├── Outbound queue       — Dexie-backed FIFO, retries, circuit breakers
  └── ConnectorDrafts      — pending draft CRUD
```

### Database schema (v18)

Eight new Dexie tables added in `lib/db/schema.ts` v18:

| Table                   | Key  | Purpose                                           |
| ----------------------- | ---- | ------------------------------------------------- |
| `adapterInstances`      | `id` | One row per configured bot (Telegram, Discord, …) |
| `platformIdentities`    | `id` | One row per observed platform user                |
| `inboundLedger`         | `id` | Dedup ledger (10 k cap)                           |
| `outboundQueue`         | `id` | Outbound delivery jobs                            |
| `conversationOverrides` | `id` | Per-conversation mode/character overrides         |
| `connectorAudit`        | `id` | Capped audit log (5 000 rows)                     |
| `connectorDrafts`       | `id` | Pending drafts awaiting human approval            |
| `connectorAttachments`  | `id` | Cached platform attachments                       |

### Five built-in platform adapters

Each adapter follows the same decomposition:
`parse.ts` / `serialize.ts` / transport / `capability.ts` / `sigverify.ts` / `index.ts`.

| Platform      | Transport                           | Signature verification                                                               |
| ------------- | ----------------------------------- | ------------------------------------------------------------------------------------ |
| Telegram      | Long-poll (`getUpdates`) or webhook | X-Telegram-Bot-Api-Secret-Token (HMAC-SHA256)                                        |
| Discord       | Gateway WS (v10)                    | Ed25519 (X-Signature-Ed25519)                                                        |
| Slack         | Events API webhook                  | HMAC-SHA256 (X-Slack-Signature v0)                                                   |
| Lark / Feishu | Event callback webhook              | Verification token (`header.token`) + optional AES-256-CBC body decrypt (schema 2.0) |
| OneBot v11    | Reverse-WS (device connects in)     | Bearer token (optional)                                                              |

### Outbound runner guarantees

- **Per-adapter circuit breaker** — trips after 50% failure rate in a 10-event window; re-opens
  after 30 s cooldown.
- **Per-adapter token bucket** — capacity 20, 5 tokens/s refill.
- **Exponential back-off** — `min(60 000, 1 000 × 2^attempts) + jitter(0–500 ms)`.
- **Dead-letter at 5 attempts** — rows transition to `deadlettered`; no more retries.
- **Idempotency LRU** — 1 000-entry cache short-circuits platform re-deliveries.
- **FIFO per conversation** — `Map<conversationKey, Promise<void>>` lane ensures ordering.
- **Quiet hours + global mute** — optional `quietHours` window and `muted` flag per adapter
  instance defer outbound jobs without counting as failures.

### Mode routing

Three modes governed by a three-layer policy stack:
`adapter default → per-conversation override → event-level override`.

| Mode     | Behaviour                                                                     |
| -------- | ----------------------------------------------------------------------------- |
| `auto`   | Bus calls `sendPrompt` (stubbed Phase 1); final AI text enqueued as outbound. |
| `manual` | User types reply in the Composer; `enqueueOutbound` called directly.          |
| `draft`  | AI generates a `ConnectorDraft`; user approves or rejects via the Inbox UI.   |

### Inbox UI

`app/inbox/` renders an Inbox shell (`InboxShell`) with a sidebar (`InboxSidebar`) listing
all platform-bound `ChatSession` rows, and a detail pane with `ConversationHeader` /
`MessageList` / `DraftBanner`. The `/inbox/[conversationKey]` route is a client-only static
page compatible with `output: "export"`.

### Settings UI

`components/settings/connections/connections-section.tsx` — tabbed shell at
`?section=connections` in Settings. Tabs: Overview / Adapters / Conversations / Inbox /
Outbound / Audit. Each tab is a separate component under `./tabs/`.

### Plugin extension API (Task 110)

`PluginManifest.connectors[]` (added to `types/plugin/plugin.ts`) lets a plugin declare
adapter factories. The `lib/plugin/connectors-bridge.ts` bridge discovers and registers them
with the `ConnectorBus` on plugin enable, and unregisters on disable.

### Web-mode degradation (Task 111)

Adapters require the Tauri desktop runtime. In web mode:

- `ConnectionsSection` shows a top banner explaining the limitation.
- The `ConversationHeader` mode switcher is wrapped in a `pointer-events-none` disabled span.
- The Composer's Send button is disabled for platform-bound sessions.

### Proactive outbound via scheduler (Task 108)

Two new `SchedulerEventType` entries:

- `connection:outbound:send` — directly enqueues an outbound job (no AI).
- `connection:scheduled:digest` — Phase 1 stub; will invoke `sendPrompt` in Phase 1+.

Both are registered as `TaskExecutor` via `lib/connectors/scheduled-outbound.ts`.

---

## Implementation outcomes (deltas from original spec)

| Aspect                          | Original spec          | As implemented                                                        |
| ------------------------------- | ---------------------- | --------------------------------------------------------------------- |
| Database schema version         | v16                    | v18 (v16 added canvas, v17 external bridge, v18 connectors)           |
| ADR number                      | 0008                   | 0009 (0008 taken by external bridge)                                  |
| axum version                    | 0.7                    | 0.8 (latest stable at implementation time)                            |
| AI run in auto mode             | Full `sendPrompt`      | Phase 1 stub — records audit + placeholder job; deferred to Task 40+  |
| `segmentsToPlainText` separator | Unspecified            | `" "` (single space join across text/markdown segments)               |
| Tauri Rust HTTP proxy           | axum                   | cognia-next `connectors_http_request` Tauri command                   |
| Phase 1 E2E scope               | Full auto/manual/draft | Auto+manual smoke only; draft mode deferred pending real `sendPrompt` |

---

## Consequences

**Positive**

- cognia-next AI characters become real bots on 5 major platforms.
- Outbound queue is battle-tested (circuit breaker, rate limit, back-off, dead-letter).
- Plugin API enables community connectors without forking.
- Web users get a clear degradation path rather than silent failures.

**Negative / deferred**

- The `auto` mode AI loop is stubbed; full `sendPrompt` → reply → outbound integration is
  Phase 1+ work (Task 40+). **Closed in v38** — see `runConnectorDigestTurn` in
  `lib/connectors/scheduled-outbound.ts`.
- Attachment caching (`connectorAttachments` table) is schema-only; the fetch pipeline is
  Phase 2. **Closed in v38** — TS dispatcher in `lib/connectors/attachment-fetcher.ts`
  (Rust implementation in `src-tauri/src/connectors/attachments.rs` was already complete).
- OAuth flows for Slack/Lark are partially wired; production tokens require Tauri keyring
  integration and a hosted redirect URL. Status remains partial; see ADR-0025 follow-up.

---

## v38 — IM completion track (2026-05-18, see ADR-0025)

Schema bumped v18 → v38 with three additions:

- `inboundLedger.namespace` (default `"inbound"`) so the same dedup machinery
  serves connector callbacks; backfill upgrade hook tags every legacy row.
- New `connectorCallbackBindings` table — written by the per-platform A2UI
  mapper at outbound time, read by `ConnectorBus.dispatchConnectorCallback`
  to recover `(surfaceId, componentId, conversationKey)` from the wire
  action id.
- `adapterInstances.lastKnownCapabilities` — cached `A2UICapabilityMatrix`
  refreshed by `ConnectorBusProvider` on each adapter registration.

Phase 2 closure:

- `runConnectorDigestTurn` drives the full `resolveSendOptions → safeSendPrompt →
assistantReplyToSegments → enqueueOutbound` pipeline. PII gating runs before
  every IM-driven turn via `lib/connectors/ai-loop/safe-send-prompt.ts`.
- A2UI surfaces project natively into Slack Block Kit / Lark Interactive Card /
  Telegram InlineKeyboardMarkup / Discord Embed + Components / OneBot text-and-image.
  Each platform's coverage is in ADR-0025's capability table.
- Inbound callbacks (`block_actions` / `INTERACTION_CREATE` / `callback_query` /
  `im.interactive_message.action_triggered_v1`) flow through
  `ConnectorBus.dispatchConnectorCallback` → `builtin:a2ui-bridge` MCP server
  (new `a2ui_handle_connector_action` tool) → fresh AI-loop turn.
- Computer Use is blacklisted for IM sessions by default; opt-in lives on
  `ConversationOverrideRow.allowComputerUse`.

### v39 (2026-05-20) — `im-gleaming-quail` completeness pass

End-to-end audit of the IM connector surface produced fifteen concrete
improvements. All shipped behind the same plan file under
`~/.claude/plans/im-gleaming-quail.md`.

**Bug fixes (link-chain):**

- **Telegram `webhookSecret` persistence** — `credentialsRef.accounts` now
  declares both `botToken` and `webhookSecret`; existing rows auto-migrate
  on edit so the secret survives restart and reaches the Tauri verifier.
  (`components/settings/connections/forms/telegram-config.tsx`)
- **Lark TAT 401 auto-refresh** — new `lib/connectors/adapters/lark/auth-retry.ts`
  exports `LarkApiError`, `isLarkTatInvalidation`, and `withTatRefresh`.
  Wrapping `doRequest`, `send`, and `edit` (for the upload pre-pass) means
  the adapter recovers from server-side TAT revocation in one retry
  instead of waiting up to two hours for the natural TTL.
- **Callback bindings TTL** — `recordCallbackBinding` now defaults
  `expiresAt = createdAt + 30 d`. New `lib/connectors/callback-binding-cleanup.ts`
  runs daily on `ConnectorBusProvider` start; it reaps explicit expiries
  - pre-default-TTL rows past a 60-day grace window. No schema bump
    required — the `expiresAt` column already existed.

**Diagnostic / observability:**

- **Heartbeat carries runtime snapshot** — `CircuitBreaker.snapshot()` and
  `TokenBucket.snapshot()` are new pure-read accessors;
  `outbound-runner.ts` publishes its per-adapter state map through a new
  module-level `getAdapterRuntimeStateSnapshot(adapterId)`. The heartbeat
  audit row's `fields` block now carries `breakerState`, `breakerOpenedAt`,
  `breakerFailureRate`, `breakerEventCount`, `rateAvailable`,
  `rateCapacity`, `rateRefillPerSec`, `rateNextRefillAt`.
- **Outbound row badges** — new `lib/connectors/derive-job-badge.ts` pure
  helper. `outbound-tab.tsx` live-queries `outboundQueue` +
  `adapterInstances` + the latest heartbeats so each pending row carries a
  derived overlay: `paused-muted`, `paused-quiet-hours` (with ETA),
  `circuit-blocked`. Uses the same `isInQuietHours` / `msUntilQuietEnd`
  helpers the runner uses, so the UI and runtime always agree.
- **Audit conversation-key filter + export** — `audit-tab.tsx` gains a
  substring filter on `conversationKey` and an Export menu (CSV / JSON)
  backed by the new pure `lib/connectors/audit-export.ts`. Files are
  named `cognia-audit-<scope>-<YYYYMMDDHHmm>.{csv,json}` and stream via
  the standard `URL.createObjectURL` + anchor pattern.
- **Health detail panel runtime card** — surfaces the breaker pill (closed /
  half-open / open with opened-at timestamp) and a rate-bucket gauge with
  next-refill ETA. The `useAdapterHealth` hook now exposes `breaker` and
  `rateBucket` typed snapshots derived from the latest heartbeat row.
- **Inbox header adapter-degradation badge + Reconnect** — amber/red
  badge when the adapter state is `degraded` / `down` / `unknown`. Click
  opens a popover with a Reconnect button that drives the existing
  `requeueAdapter` lifecycle hook. Reuses `useAdapterHealth`, so no new
  live-query plumbing.

**Verify + UX completion:**

- **Send test message** — new `SendTestMessageSection` mounted in the
  Adapters → Config detail tab, driving a real `getBus().sendOutbound`
  through the bus's full pipeline (any platform). Pairs with the existing
  `AdapterWhoamiPanel` (probe leg) so each platform has both
  "credentials valid?" and "end-to-end works?" affordances.
- **Quiet hours custom timezone + responsive grid** — the 12-zone
  dropdown now offers a `Custom…` option that switches to a freeform
  IANA input with `Intl.DateTimeFormat` validation. Grid layout drops to
  one column on narrow screens (`grid-cols-1 sm:grid-cols-3`).
- **ConversationsTab CU badge** — surfaces
  `ConversationOverrideRow.allowComputerUse === true` as a small badge so
  operators can spot computer-use-enabled channels at a glance.
- **Discord `publicKey` Phase-2 cleanup** — field is now labelled
  `[Phase 2]` with an inline advisory; Phase 1 no longer writes the
  value to keyring (avoiding the ghost-credential foot-gun) since Gateway
  transport doesn't consume it.

**Advanced:**

- **Outbound deadlettered bulk-retry** — when the filter is set to
  `deadlettered` with one or more rows visible, a "Retry all" button
  appears in the chip strip. Reuses the existing single-job retry
  semantics inside a Dexie `bulkPut`.
- **Inbound at-gate stats** — new pure summariser
  `lib/connectors/at-gate-stats.ts:summariseAtGateBlocks` rolls up the
  existing `inbound.policy_blocked` audit rows (no new instrumentation
  required). Health detail surfaces "Inbound filter (24h): N dropped,
  reasons: …". Folds long tails into an `other` bucket via the `topN`
  option.

**Follow-ups not in this branch:**

- The OneBot reverse-WS probe today fires through the existing
  `handleVerify` flow in `onebot-config.tsx`, which listens for
  `connectors://onebot/<adapterId>/open` Tauri events with a 10 s
  timeout. A dedicated `connectors_onebot_probe` Tauri command that
  surfaces the live `ws_server.connected_clients()` table is a clear
  next step — listed in the plan as Task 3.2's Rust leg.

---

## References

- Original spec: `C:\Users\qwdma\.claude\plans\d-project-agentforge-astrbot-fluttering-cerf.md`
- Implementation plan: `docs/superpowers/plans/2026-05-05-platform-connectors.md`
- Key files: `lib/connectors/`, `types/connectors/`, `src-tauri/src/connectors/`,
  `components/settings/connections/`, `components/inbox/`, `app/inbox/`
