# Plan: scheduler host-neutral execution + dormant-feature wiring

Spec: `docs/superpowers/specs/2026-08-16-scheduler-host-neutral-design.md`. Each phase is one
pathspec-only commit (`git commit --only -- <paths>`), tests co-located, ≥90% on touched files,
i18n edited in the split sources (`i18n/messages/{en,zh-CN}/**` + `pnpm i18n:build`).

## Phase 1 — executor host gating & hygiene (`lib/scheduler`, `types/scheduler`)

- **New** `lib/scheduler/host-support.ts`: `SchedulerHostContext { platform, hasCapability }`,
  `getTaskTypeHostSupport(type, ctx): { supported: boolean; reason?: TaskTypeUnsupportedReason }`,
  `DEPRECATED_TASK_TYPES = ["sync","ai-generation"]`, `unsupportedOnHost(reason)` executor result
  helper (`{ success:false, error, terminalReason:"unsupported-on-host" }`), and
  `describeLocalHost()` built from `lib/platform/{detect,capabilities}`.
- Replace `isTauri()` in `executors/index.ts` (chat/agent/skill → `sidecar`), `goal-executor.ts`
  (`sidecar`), `script-executor.ts` (`shell`), `wiki-rebuild-executor.ts` (`shell`),
  `backup-executor.ts` (filesystem seam — Phase 6 completes it; Phase 1 only swaps the gate to
  `hasBackupFilesystem()`), `sources/system-source.ts` (`deps.isAvailable ?? isDesktopHost`).
- `custom` fallthrough → `SchedulerError.executorNotFound`.
- **New** `executors/test-executor.ts` (`TestTaskPayload { echo?, delayMs?, failWith? }`).
- `task-scheduler.ts`: (a) executor registry emits `executor-registered`; a due task with no
  executor waits up to `EXECUTOR_REGISTRATION_GRACE_MS` (60 s) after scheduler start, then
  fails; (b) `pauseDeprecatedTasks()` at init writes an execution row
  (`terminalReason: "deprecated-type"`), sets `status: "paused"`.
- `types/scheduler/index.ts`: `TestTaskPayload`, `TaskExecutionTerminalReason` +
  `"unsupported-on-host" | "deprecated-type"`, stale comments fixed; `unified.ts` header.

## Phase 2 — `workflow` + `im-push` executors

- `types/workflow/visual.ts`: `WorkflowTriggeredFrom.source` + `"schedule"`;
  `types/workflow/deployment.ts`: `WorkflowEntrypoint` + `"schedule"`; update exhaustive
  consumers found by `tsc`.
- **New** `executors/workflow-executor.ts` — `WorkflowTaskPayload { workflowId, environment?,
  inputs?, triggerId? }`; `executeDeployedWorkflow({ entrypoint:"schedule", caller:
  "scheduler:task:<id>", triggerKind:"trigger.manual", payload: inputs, signal, triggeredBy:
  {source:"schedule", …} })`; output `{ runId, invocationId, status }`.
- **New** `executors/im-push-executor.ts` — `ImPushTaskPayload { conversationKey, text?,
  segments?, idempotencyKey? }`; resolve `deliveryTarget` from `getConnectorConversationState`,
  enforce `proactivePush` opt-in (`readForResolution`), `hasNoLeakingPii`, then `enqueueGoverned`.
- **New** payload editors `components/scheduler/payload-editors/{workflow,im-push}-payload-editor.tsx`
  and wiring in `task-form.tsx`; i18n keys under `scheduler.*`.

## Phase 3 — timing

- **New** `lib/scheduler/timing/node-driver.ts` (`NodeTimingDriver`, `supportsLeaderElection=false`).
- `task-scheduler.ts` default driver: `tauri → Rust`, `headless → Node`, else renderer.
- `tab-lock.ts`: guard `window.addEventListener` absence.

## Phase 4 — headless bridges

- `lib/tauri/transport-companion.ts`: `subscribe()` sends `{type:"subscribe", channels:[…]}` and
  re-sends on reconnect; `unsubscribe` frame on last handler removal.
- `lib/workflow/runtime/tauri-bridge.ts`: `listenTriggerEvents` / `listenIntegrationDeliveryAvailable`
  fall back to `getTransport().subscribe(...)` when not Tauri.
- **New** `lib/headless/runtimes/workflow-trigger-bridge.ts` (registered in `runtimes/index.ts`).
- `lib/notifications/runtime.ts`: `push` on headless → `remote_notification_publish`; toast/os
  skipped on headless. **New** `lib/notifications/remote-subscription.ts` — companions subscribe
  to `notification://remote` and insert into the center; mounted from an initializer.

## Phase 5 — OS promotion (desktop)

- Rust `crates/cognia-scheduling/src/scheduler/{types,macos,linux,windows}.rs`: `OpenUrl { url }`
  + capability rows; TS `types/scheduler/system-scheduler.ts`.
- `promote-to-system.ts`: any type / cron|interval|once → `open_url` of
  `cognia://scheduler/task/<id>?run=<token>`; `unpromote`.
- `types/scheduler`: `ScheduledTask.promotion?: { systemTaskId, token, promotedAt }`;
  `scheduler-db.ts` serialises it; scheduler skips arming promoted tasks.
- `hooks/system/use-tauri-events.ts`: `open_scheduler_task` with `run` param → verify token via
  store → `runTaskNow`; else navigate.
- UI: promote/unpromote in task detail actions + confirm dialog (existing `promote.*` keys).

## Phase 6 — backup destinations

- `backup-executor.ts`: `BackupFilesystem` injection (`lib/data/backup-scheduler.ts` seam),
  destination dispatch table.
- **New** `lib/data/destinations/github.ts`, `lib/data/destinations/googledrive.ts`,
  `lib/data/destinations/config.ts` (settings shape); `lib/db/backup-history.ts` +
  `destination`.
- Google OAuth: `src-tauri/src/backup_oauth.rs` (desktop commands + headless callback route),
  `sidecar/google-oauth-helper.mjs`, `lib/backup/google-oauth.ts`.
- `components/settings/data/{github-backup-card,google-drive-backup-card}.tsx`;
  `backup-schedule-dialog.tsx` options; `convex` deprecated.

## Phase 7 — UI

- `task-form.tsx`: type items disabled + reason via `getTaskTypeHostSupport` with the active
  host's capabilities (`useHostProfile` / remote-host-store).
- **New** `components/scheduler/scheduler-host-bar.tsx` + read-only other-side view;
  deprecated notice in task detail; i18n.

## Phase 8 — docs & gates

- ADR-0128 (en + zh), subsystem doc host matrix, `.changeset/scheduler-host-neutral.md`,
  `/preflight`, gates verbatim.
