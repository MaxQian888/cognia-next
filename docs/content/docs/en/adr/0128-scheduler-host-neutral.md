---
title: ADR-0128 — Host-neutral scheduler, executor completeness, and remote backup destinations
description: One scheduler contract for the desktop, the headless brain, and the web / companion shells — capability-gated executors instead of isTauri() cliffs, host-owned placement, a Node timing driver, headless bridges for workflow triggers and notifications, OS promotion as wake-and-delegate, and GitHub / Google Drive backup backends.
---

# ADR-0128 — Host-neutral scheduler, executor completeness, and remote backup destinations

| Field     | Value                                                                                                                                                                                                                                                             |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status    | Accepted                                                                                                                                                                                                                                                          |
| Date      | 2026-08-16                                                                                                                                                                                                                                                        |
| Builds on | ADR-0002 — Scheduler; ADR-0079 — Scheduling crate; ADR-0082 — Remote host / companion transport; ADR-0090 — Unified agent execution; ADR-0011 — Visual workflows; ADR-0009 / 0036 — Connectors + outbound governance; ADR-0001 — Data backup                       |
| Scope     | `lib/scheduler/**`, `types/scheduler/`, `components/scheduler/`, `stores/scheduler/`, `lib/headless/runtimes/`, `lib/notifications/`, `lib/data/destinations/`, `crates/cognia-scheduling/`, `src-tauri/src/rpc/data_sync.rs`, settings → Data cards.           |

## Context

An audit of the scheduler (task model, executors, timing drivers, promotion, companion RPCs, backup) against the three shells the app ships in established:

- **Executors were gated on `isTauri()`.** Backup, wiki-rebuild, goal, script, and system-source refused to run anywhere but the desktop, including on the headless brain (`cognia-server`), whose runtime roster already installs a scheduler. Their failures were plain `Error`s, indistinguishable from bugs.
- **Four task types were dead.** `workflow` and `im-push` were in the enum and the form but had no executor; `sync` and `ai-generation` had neither an executor nor a plausible backing system. `custom` without a registered handler silently succeeded. There was no diagnostic type to validate a trigger chain end-to-end.
- **Timing was renderer-shaped.** The tab-lock touched `BroadcastChannel`/`window` unconditionally, so a Node process either crashed or ran without a driver. There was no `setTimeout`-backed timing driver for the headless host.
- **Headless had no path back to the user.** Workflow triggers on the brain were only reachable through Tauri events; toast / OS notifications raised on the brain went nowhere.
- **OS promotion re-executed the task out of process.** The promoted `cognia.exe --task <id>` path duplicated executor plumbing that only the running app owns (sidecar session, connectors, keyring), so promoted runs diverged from in-app runs.
- **Backups had one real remote leg (WebDAV / S3) and one dead one** (`convex`, never wired) and no way to run on the brain, whose "filesystem" is a different seam.
- **The UI could not tell whose schedule it was showing.** A desktop driving a remote host, and a phone / cloud companion, silently read the remote host's tasks; the type picker offered everything everywhere.

The full grill (30 confirmed decisions) and design are in `docs/superpowers/specs/2026-08-16-scheduler-host-neutral-design.md`; the plan in `docs/superpowers/plans/2026-08-16-scheduler-host-neutral.md`.

## Decision

### 1. Capability gates, not platform cliffs

`lib/scheduler/host-support.ts` declares, per task type, what the host must provide (`TASK_TYPE_HOST_REQUIREMENTS`): a `CapabilityId` from `lib/platform/capabilities` (`sidecar`, `shell`, `connector-runtime`) or one of two scheduler-only requirements — `host-filesystem` (desktop or headless) and `desktop-shell` (Tauri process only). Executors call `assertTaskTypeSupportedOnHost` and fail with a **structured** result (`terminalReason: "unsupported-on-host"`) instead of a bare throw. Types with no requirement (`workflow`, `test`, `plugin`, `custom`) run wherever an executor is registered.

Deprecated types (`sync`, `ai-generation`) stay in the enum for persisted rows, are refused on create / resume (`SchedulerError.deprecatedTaskType`), auto-paused at scheduler init (`pauseDeprecatedTasks`), and labelled on all three axes: the type doc-comment, the detail-view banner, and a test. `custom` without a registered handler fails with `EXECUTOR_NOT_FOUND`. A task whose executor is registered late (plugin boot) is retried inside a 60 s grace window (`waitForTaskExecutor`) before failing.

Runnable-by-host matrix (the picker shows unsupported types **disabled with the reason**, never hidden — Working Rule 7):

| Type                                                        | Requires            | Desktop | Headless brain | Web / companion webview |
| ----------------------------------------------------------- | ------------------- | ------- | -------------- | ----------------------- |
| `chat` `agent` `skill` `goal` `plan` `agent-team`           | `sidecar`           | ✓       | ✓              | ✗                       |
| `external-agent` `script` `background-command` `monitor`    | `shell`             | ✓       | ✓              | ✗                       |
| `backup` `wiki-rebuild`                                     | `host-filesystem`   | ✓       | ✓              | ✗                       |
| `im-push`                                                   | `connector-runtime` | ✓       | ✓              | ✗                       |
| `workflow` `test` `plugin` `custom` (with handler)          | —                   | ✓       | ✓              | ✓                       |
| `system` (native OS tasks, card-authored)                   | `desktop-shell`     | ✓       | ✗              | ✗                       |
| `sync` `ai-generation`                                      | deprecated          | paused  | paused         | paused                  |

### 2. Executor completeness

- **`workflow`** — `executeDeployedWorkflow` with a new `WorkflowEntrypoint` / `WorkflowTriggeredFrom.source` value **`"schedule"`**, caller `scheduler:task:<id>`, idempotency key `<taskId>:<executionId>`.
- **`im-push`** — resolves the bound conversation, honours the per-conversation `proactivePush` opt-in, passes `hasNoLeakingPii`, and enqueues through the governed outbound queue (`enqueueGoverned`) so quiet hours, rate limits, and audit (`notify.im_*`) apply exactly as for agent-initiated pushes.
- **`test`** — echoes its payload; used to validate a trigger chain end-to-end on any host.
- **`script`** — pluggable `ScriptRunner`: `shell_exec` on the desktop, the jobs supervisor on headless.

### 3. Timing drivers per host

`resolveDefaultTimingDriver()` picks the Rust daemon on Tauri, `NodeTimingDriver` (`lib/scheduler/timing/node-driver.ts`, `setTimeout` chunked at the 2³¹−1 ms ceiling) on headless, and the renderer driver + tab-lock on web / mobile. The tab-lock guards on `hasBrowserWindow()` so a Node process never touches `BroadcastChannel`.

### 4. Headless bridges

- **Workflow triggers** — `lib/headless/runtimes/workflow-trigger-bridge.ts` subscribes to `workflow:trigger` through the Companion transport's `/internal/events` subscribe control frames (`{type:"subscribe", mode:"add|remove|replace", channels}`); `lib/workflow/runtime/tauri-bridge.ts` uses the same path off-Tauri.
- **Notifications** — toast / OS notifications raised on the brain are published once per record through the `remote_notification_publish` RPC (Rust `rpc/data_sync.rs`, now with an optional `source`) on the `notification://remote` channel; connected clients ingest them into the local notification center (`lib/notifications/remote-subscription.ts`, mounted by `remote-notification-initializer.tsx`). FCM / APNs remain out of scope.

### 5. OS promotion is wake-and-delegate

A promoted task no longer re-executes out of process. The native entry runs a new `SystemTaskAction::OpenUrl` (macOS `open`, Linux `xdg-open`, Windows `cmd /C start`, allow-listed to `cognia:` / `https:` / `http:` by `validate_open_url`) with the wake URL `cognia://scheduler/task/<id>?run=<token>`. The app's deep-link handler verifies the per-promotion token (`ScheduledTask.promotion { systemTaskId, token, promotedAt, backend }`) and runs the task through the ordinary in-app executor. Pause / resume / delete mirror to the OS entry; promoted tasks are not armed by the in-app loop. Headless hosts do not promote (always-on).

### 6. Host-owned placement and the host bar

Every host keeps its own `CogniaSchedulerDB`; nothing hands tasks between hosts. A client chooses which reachable schedule it **manages** — `local` (this device) or `paired` (the host it drives / is paired with, through the `scheduled_task_*` RPCs) — in `lib/scheduler/scheduler-host-target.ts`. Defaults: companions and a desktop driving a remote host prefer `paired`; a remembered `paired` degrades to `local` while unreachable. The scheduler pages show a host bar ("Managing: this device / cloud host <name>", suspended badge, only-while-open note, switch button); the type picker resolves the **target** host's capabilities via the `host_capabilities` RPC.

> **Amended by ADR-0136 (2026-08-21).** "Nothing hands tasks between hosts"
> stands — a host still owns its own `CogniaSchedulerDB` and no task row ever
> travels. What changed is *arming*: `isTimingAuthority()` used to return `true`
> unconditionally whenever the timing driver had no leader election, which is
> every driver in production, so two desktops signed into one account each armed
> the same cron and each fired it. It now consults the configured execution
> authority (`lib/placement/authority.ts`). **Unconfigured still means
> self-authority**, so a single-machine install is unchanged; a configured host
> owns timing and the others stand down; and an authority that stays unreachable
> past its grace window is taken over locally with a visible `placement.degraded`
> record rather than silently stopping the schedule. Handoff is by standing
> down, never by transferring state, and duplicate fires are absorbed by the
> deterministic idempotency key rather than prevented by an election.

### 7. Remote backup destinations

`lib/data/destinations/` gains **GitHub** (contents API into a private repo — public repos are refused) and **Google Drive** (user-supplied OAuth client, **device flow**, `drive.file` scope, tokens in the `backup-destinations` keyring namespace) legs, plus a manual "Sync now" that runs the same pipeline as the scheduled `backup` executor. `convex` is deprecated in place. The executor fans out per leg and records `destination` in backup history. Host filesystem access goes through `lib/data/backup-host-filesystem.ts` so the headless runtime injects its own seam. Settings → Data hosts the two cards; the schedule dialog only offers destinations that are configured.

> **Amended 2026-08-27.** Three of the mechanisms above were half-connected in
> practice, and this amendment closes them:
>
> 1. **The host gate is now checked centrally too.** §1 says executors call
>    `assertTaskTypeSupportedOnHost`. `plan`, `agent-team`, `background-command`
>    and `monitor` declared requirements in `TASK_TYPE_HOST_REQUIREMENTS` and
>    their executors never called it, so on a host without the capability they
>    failed with a bare `Error` — exactly the failure mode §1 set out to remove.
>    `task-scheduler.ts` now evaluates the same table before dispatch, so the
>    structured `unsupported-on-host` row cannot be skipped by an executor that
>    forgets. The per-executor calls stay: they are the documented contract and
>    they fail earlier.
> 2. **§6's host target now binds the whole page.** The store honoured
>    `getSchedulerDataSource()` on every read and write, but the unified `app`
>    and `plugin` sources were hard-wired to the local Dexie and the local
>    `TaskScheduler`. Selecting a paired host therefore gave a sidebar, calendar
>    and facet counts from *this* device above a detail pane, pause and run-now
>    acting on the *remote* one. Both sources now resolve their backend per call
>    and re-subscribe when the target flips; a remote schedule is polled
>    (30 s) because the companion transport has no change feed for
>    `scheduled_task_*`, and re-read immediately after their own writes. The
>    four kinds with no cross-host RPC (backup / workflow / system / connector)
>    stay local and the host bar says so.
> 3. **Progress is recorded and can notify.** `TaskNotificationConfig.onProgress`
>    and the `"progress"` branch of the notification layer both existed and were
>    unreachable: the only producer, `PluginTaskContext.reportProgress`, wrote to
>    `log.debug`, and both authoring paths hard-coded `onProgress: false`.
>    `lib/scheduler/execution-progress.ts` now records reports on the execution
>    row and raises the notification when the task opted in, with coalesced
>    writes, a per-execution notification rate limit, and a cap on retained
>    progress entries. The task form owns the switch.

## Consequences

- Any new task type must declare its requirements in `TASK_TYPE_HOST_REQUIREMENTS` (or explicitly none) — the picker, the executor gate, and the docs matrix all read that one table.
- Runs refused for host reasons are visible as `unsupported-on-host` execution rows, not exceptions; monitoring can distinguish them from executor bugs.
- Promoted tasks now behave identically to in-app runs; the previous out-of-process re-execution path is gone. Older promotions without a token are re-promoted on first use.
- The web-standalone shell has a strictly smaller live surface, and says so inline instead of failing at run time.
- Companion / remote clients must handle the `subscribe` control frame and `notification://remote` channel; older servers simply never emit them.
- Backup destinations that require user credentials (GitHub token, Google client secret / tokens) live only in the host keyring and are excluded from settings sync.
