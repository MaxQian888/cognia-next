---
title: ADR-0042 — Unified Notification Center
description: "A single notify() pipe backed by a durable Dexie v68 notifications table unifies the scheduler, agent-team, plugin, connector, session, and mobile-push notification paths behind one source of truth — with dedup/coalescing, a 3-state read model, snooze, DND/quiet-hours, preference-governed channel fan-out (center/toast/os/push), a status-bar bell with a two-tier badge, a notification center panel, a preferences section, and a mobile feed."
---

# ADR-0042 — Unified Notification Center

**Status**: Accepted (2026-06-02)
**Authors**: Max Qian + Claude Opus 4.8
**Builds on**: the scheduler notification integration (ADR-0002), the agent-team notifier (ADR-0022 §3.4), the plugin notification API (ADR-0006/0026), the connector bus (ADR-0009), mobile push (ADR-0027), and the quiet-hours evaluator from `lib/connectors/outbound-runner`
**Affects**: `types/notifications/` (new), `lib/notifications/` (new), `lib/db/notifications.ts` + `lib/db/schema.ts` (v68), `stores/notifications/` + `stores/inbox/active-conversation-store.ts` (new), `hooks/notifications/` (new), `hooks/chat/use-session-notifications.ts`, `lib/scheduler/notification-integration.ts`, `lib/ai/agent/team/team-notifier.ts` + `agent-team-runtime-deps.ts`, `lib/plugin/api/notification-api.ts`, `components/notifications/` + `components/settings/notifications/` + `components/mobile/notifications/` (new), `components/desktop/status-bar.tsx`, `components/providers/tauri-provider.tsx`, `app/inbox/c/[conversationKey]/`, `app/me/notifications/`, `lib/claude/types.ts` (`AppSettings.notificationPreferences`), `i18n/messages/{en,zh-CN}.json`

## Context

Research found the app's notification/feedback surface was **delivery-focused but had no unified pipe or persistent UI**:

- **No central store.** The scheduler (`notification-integration.ts`), plugins (`notification-api.ts`, in-memory `Map`), agent-team (`team-notifier.ts`), and mobile push (`push-notifications.ts`) each owned a separate path with its own toast/OS routing.
- **No in-app center / history / unread badge / preferences.** Plugin notifications were in-memory only (lost on reload); toasts faded; there was no bell, no count, no DND.
- **Dangling wiring.** `setToastDispatcher` (plugin API) was exported but never called; `subscribeToPushNotifications` (mobile) had no UI consumer; inbound connector messages and inbox arrivals never notified the OS or a badge.

The goal (scoped with the user): a **unified outbound notification center** — one `notify()` pipe writing a durable record plus preference-governed fan-out — **and** wiring **inbound events** (connector messages, mobile push, session completion) into the same pipe.

### Mature-design basis

Validated against Slack, GitHub Inbox, Linear, MS Teams, VSCode, and Novu/Knock. Adopted: a 3-state read model (`unseen → seen → read → done`, GitHub/Novu); group-by-entity with a coalesced count; per-notification snooze with auto-wake on activity (Linear) + a global DND schedule (Knock quiet-hours); ~3 obtrusiveness tiers with `critical` bypassing DND (Teams/VSCode; Novu `critical → readOnly` preference bypass); focus-aware delivery (suppress OS while viewing the surface, Slack); global default + per-source override-as-exception (not a full matrix); a two-tier badge (red count for "directed at you", dot for ambient); burst coalescing via a `dedupeKey` window (Novu digest); structured serializable CTAs.

Deliberately **not** adopted (Novu enterprise-only): the two-entity event/message split, a job-DAG worker queue, topics/multicast, multi-tenant scoping, and a provider matrix. An embedded single-user desktop app uses a single `NotificationRecord` (with a `deliveredVia[]` diagnostic field) and an in-process pipe.

## Decision

### Single pipe — `lib/notifications/notify(input, deps)`

DI-style (mirrors `team-notifier`) so the orchestration is unit-testable without Dexie/sonner/Tauri. The flow: build/merge the record → **coalesce** (`dedupeKey` within a window bumps an existing row's `count` instead of inserting) → **route** (`source × level → channels`, gated by per-level OS/push thresholds, per-source mute, and DND — `critical` bypasses all three) → **persist** to Dexie + push into the reactive store → **fan out** best-effort (toast → sonner, os → Tauri, push → mobile), recording `deliveredVia` → best-effort **retention** prune. The host wires the real dependencies once in `lib/notifications/runtime.ts`.

### Data model (`types/notifications/`)

`NotificationRecord` is the durable "center" entry: `id, source, level, title, body?, createdAt, updatedAt, readState, snoozedUntil?, dedupeKey?, groupKey?, count, href?, actions?, sourceRef?, pluginId?, directed, deliveredVia[], expiresAt?`. The `notifications` Dexie table (**v68**) indexes `dedupeKey`, `groupKey`, `createdAt`, `readState`, plus the compound `[readState+createdAt]` (newest-unread feed + badge) and `[source+createdAt]` (per-source feed). Actions are **serializable** (`{ id, label, command, args? }`) — resolved at click time through `action-registry`, never closures (they persist). `NotificationPreferences` rides the `AppSettings` singleton as JSON (no migration), resolved with `DEFAULT_NOTIFICATION_PREFERENCES`.

### True unification of legacy paths

- **Scheduler** `notifyTaskEvent` builds a `NotificationInput` (`desktop → os`, `toast → toast`) and calls the core. The **webhook** channel stays scheduler-owned (it is an outbound HTTP integration, not a user notification). `TaskNotificationConfig` is unchanged → backward-compatible.
- **Agent-team** `team-notifier` gains a single `deliver` sink: one emit per event, the core routes by level (`info → center`, `warn → +toast`, `critical → +toast+os+gate`). Its dedupe/suspend/`openGate` semantics are unchanged; the default deps lazy-load the core.
- **Plugins**: the dangling `setToastDispatcher` is implemented via `plugin-bridge` → plugin notifications become first-class center entries (history), with the action closure registered as a serializable command.

### Inbound wiring

A passive `ConnectorBus.subscribeInbound` observer turns user-meaningful messages (`kind = create`, non-self, non-empty) into center notifications keyed by `conversationKey`; `mentions.selfMentioned`/private channels mark them `directed`. **Focus-aware**: when the window is focused and the user is viewing that conversation (tracked by `stores/inbox/active-conversation-store`, set by the inbox route), the OS channel is suppressed while the center still records. The dangling mobile `subscribeToPushNotifications` consumer is wired (background push = center-only, since the OS already showed it; foreground = center+toast). `use-session-notifications` routes through the core (center record + OS) and now records on web too. `installNotificationBridges()` mounts plugin/connector/push once via `TauriProvider`.

### UI

A status-bar **bell** with a two-tier badge (red numeric for `directed` unread, dot for ambient) opens the **center** panel (grouped active feed, source filter, bulk mark-all-read, archived view, per-row open/triage). The **preferences** section (`settings → Notifications`) edits channels, level gates, quiet hours, per-source mute, sound/badge, focus-awareness, snooze auto-wake, and retention, with an OS-permission CTA. A **mobile feed** (`/me/notifications`) reuses the row component with always-visible menus for touch.

## Consequences

- One source of truth: every subsystem's notifications share history, dedup, preferences, and read-state. Disabling a source still records to the center (history is never lost); only its interruptive channels are muted.
- `critical` is guaranteed delivery (security/approval), bypassing mute and DND.
- The webhook channel and the per-channel delivery state of ephemeral toast/OS are intentionally not tracked beyond `deliveredVia[]`; if per-channel retry is ever needed, the single entity extends to a `messages` sub-table without reshaping callers.
- Schema version **v68** must be respected by concurrent branches (it landed alongside the unrelated eval **v69**).
