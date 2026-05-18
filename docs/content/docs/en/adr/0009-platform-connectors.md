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
  Phase 1+ work (Task 40+).
- Attachment caching (`connectorAttachments` table) is schema-only; the fetch pipeline is
  Phase 2.
- OAuth flows for Slack/Lark are partially wired; production tokens require Tauri keyring
  integration and a hosted redirect URL.

---

## References

- Original spec: `C:\Users\qwdma\.claude\plans\d-project-agentforge-astrbot-fluttering-cerf.md`
- Implementation plan: `docs/superpowers/plans/2026-05-05-platform-connectors.md`
- Key files: `lib/connectors/`, `types/connectors/`, `src-tauri/src/connectors/`,
  `components/settings/connections/`, `components/inbox/`, `app/inbox/`
