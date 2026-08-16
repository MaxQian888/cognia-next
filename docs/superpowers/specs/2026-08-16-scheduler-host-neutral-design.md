# Scheduler: host-neutral execution, dormant-feature wiring, local + cloud parity

**Date**: 2026-08-16 · **Status**: grilled & confirmed (28 decisions) · **ADR**: 0128 (to be written)

## Problem

The scheduled-task subsystem (`lib/scheduler/`, ADR-0002 / ADR-0079) is feature-rich but has a
set of built-but-dormant paths, and it silently degrades on every host that is not the Tauri
desktop:

| # | Gap | Where |
| --- | --- | --- |
| A | `workflow` / `sync` / `ai-generation` / `test` / `im-push` are declared task types with **no executor**; four of them are selectable in the form and fail only at first fire | `types/scheduler/index.ts`, `components/scheduler/task-form.tsx` |
| B | `custom` with no registered handler returns `success: true` | `lib/scheduler/executors/index.ts` |
| C | Six `if (!isTauri())` gates (chat/agent/skill, goal, backup, wiki-rebuild, script, system-source) — the headless brain registers the scheduler runtime yet every one of these tasks fails there | `lib/scheduler/executors/*` |
| D | No task ownership model; changeset says "nothing hands it to a server when your desktop is off" | `.changeset/remote-host-capabilities.md` |
| E | Headless completion notifications: only `webhook` survives; `companion_push_notification` is Tauri-only and FCM/APNs delivery is a stub even on desktop; `remote_notification_publish` exists but has no TS caller | `lib/notifications/runtime.ts`, `rpc/data_sync.rs` |
| F | Headless Rust cron daemon publishes `workflow:trigger` to the event bus, but the channel is `default_on: false`, `CompanionTransport.subscribe` never sends a subscribe frame, and the brain never subscribes | `src-tauri/src/headless/mod.rs`, `lib/tauri/transport-companion.ts` |
| G | OS promotion (`promote-to-system.ts`) has **zero callers**; the `promote.*` i18n keys are unused; the mapping targets non-existent CLI subcommands | `lib/scheduler/promote-to-system.ts` |
| H | `connection:*` executors register from a different boot chunk than the scheduler → a persisted task can fire before its executor exists | `install-connector-runtime.ts` |
| I | Form does not filter task types by host capability | `task-form.tsx` |
| J | Backup destinations `github` / `googledrive` / `convex` are enum-only | `lib/data/destinations/` |

## Decisions (from the grill)

### Scope & hosts
1. Cover three shapes: **Tauri desktop** (local) and **cognia-server headless brain** (cloud) as
   first-class execution hosts; **web-standalone** gets capability filtering + inert labelling only.
2. **Placement = host-owned.** Every host owns its own `CogniaSchedulerDB`; there is no
   cross-host hand-off. When the desktop drives a remote host, the local scheduler stays
   suspended and CRUD is routed remotely (already implemented); the UI must say which host is
   being managed and allow read-only viewing of the other side.

### Executors & types
3. New executors: `workflow` (via `executeDeployedWorkflow`, `entrypoint: "schedule"`,
   `triggeredBy.source: "schedule"` — both enum values added), `im-push` (payload
   `{ conversationKey, text | segments, idempotencyKey? }`; adapterId resolved from
   `connectorConversationState`; `hasNoLeakingPii` gate + `proactivePush` opt-in fail-closed;
   enqueues through the same governed outbound path as `connection:outbound:send`), `test`
   (echo / delay / optional failure — a real executor for validating the trigger chain).
4. `sync` and `ai-generation` are **deprecated**: removed from the form, kept in the enum,
   existing active rows auto-paused at scheduler init with an execution row explaining why;
   detail view shows a deprecation notice.
5. `custom` with no handler → `EXECUTOR_NOT_FOUND`.
6. Host gating moves from `isTauri()` to capability checks (`sidecar` for chat/agent/skill/goal,
   `shell` for script, filesystem injection for backup, `shell` for wiki-rebuild). Executors
   return a structured `unsupported-on-host` reason for the UI.
7. Executor-registration race: a due task whose executor is not yet registered waits (bounded
   grace, 60 s from scheduler start) for `registerTaskExecutor`; after that it fails as today.

### Timing & headless
8. New `NodeTimingDriver` for `platform === "headless"` (plain timers, no tab-lock, no drift
   poll). Fix the tab-lock `window.addEventListener` hazard on Node while there.
9. `CompanionTransport.subscribe` sends `{type:"subscribe"}` control frames;
   `listenTriggerEvents` uses `transport.subscribe("workflow:trigger")` off-Tauri; new
   `workflow-trigger-bridge` headless runtime (also `integration:delivery-available`).
10. Headless notifications: `notify()` push channel → `remote_notification_publish`;
    companions subscribe to `notification://remote` and write into the local center;
    `toast`/`os` degrade to center-only on headless. Real FCM/APNs delivery is out of scope.

### OS promotion (desktop only)
11. Wire the full flow: "Promote to system" button + confirm dialog; task row stores
    `promotion { systemTaskId, token, promotedAt }`; app-level arming skipped while promoted;
    un-promote supported. New `open_url` `SystemTaskAction` variant (Rust + TS + three
    backends). The OS job opens `cognia://scheduler/task/<id>?run=<token>`; the desktop deep-link
    handler runs the task only when the token matches, else it only navigates. Headless offers no
    promotion (always-on).

### Backup destinations
12. `github`: reuse `lib/github` credentials, user picks repo + sub-path, contents API upload,
    retainCount pruning, **public repositories refused**. `googledrive`: OAuth **device flow**
    (grill Q30 superseded the earlier `mcp_oauth` loopback/PKCE plan — no callback route needed,
    the same code-at-google.com/device flow works on the desktop and when driving a headless host
    from a companion; tokens + client secret in the `backup-destinations` keyring namespace),
    client id/secret supplied by the user in settings. `convex`: deprecated. Settings → Data gets GitHub / Google Drive
    destination cards; the scheduler dialog enables destinations that are configured; backup
    history rows gain a `destination` column.

### UI
13. Task-type picker filters by the (local or remote) host's capabilities: unsupported types shown
    disabled with a reason. Types created by their own cards stay out of the form.
14. Scheduler page host bar ("Managing: this device / cloud host X") with a switch to view the
    other side read-only (local list labelled "suspended: taken over by cloud host").
    Companions (phone / cloud browser) default to the **paired host's** schedule and can switch
    to this device (grill Q29); the local webview schedule is labelled "runs only while this app
    is open". The preference is remembered per device (`scheduler-host-target.ts`).

### Delivery
15. ADR-0128, bilingual subsystem doc "runnable-by-host matrix", `minor` changeset, phased
    pathspec-only commits, automated gates only (no manual smoke; unfinished verification listed).
