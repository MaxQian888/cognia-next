# Built-in scheduled-task inventory and governance audit

Date: 2026-10-20 (Asia/Shanghai).

This audit inventories the checked-out Cognia implementation, including local
changes already present. It does not read a running account's database or prove
that a particular task is currently enabled. The initial inventory was read-only;
the implementation below now changes maintenance defaults and lifecycle handling.
No live account rows were operated on during this task.

This report is separate from the scheduler subsystem guide because it records a
dated audit, findings, and follow-up acceptance criteria rather than the public
architecture contract.

## 1. Automatically installed persisted tasks

There are **12 task types in this inventory**: four scheduler-boot types, six
connector-housekeeping types, one adapter-presence type, and one external-issue
sync type. This is a count of definitions, not task rows or independent clocks.
Five housekeeping types are event consumers of one daily clock. Presence can
create a row for each configured adapter.

| Task type                                     | Cadence                                    | Creation and effective execution condition                                                                                                                                                                           | Owner                                            |
| --------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `provider-diagnostics-refresh`                | Clock every 5 min                          | Installed by scheduler boot; scans due diagnostic sources. Reachability interval: 15 min; primary balance: 30 min; other balances: 2 h. Offline/locked states postpone work; authentication failures pause a source. | `lib/provider-diagnostics/refresh.ts`            |
| `conversation-auto-archive`                   | Every 6 h                                  | Installed by scheduler boot; does no work when the archive policy is off or a paired Host owns conversations.                                                                                                        | `lib/chat/auto-archive-schedule.ts`              |
| `files-trash-purge`                           | Every 6 h                                  | Installed by scheduler boot; purges expired trash under the 30-day retention policy; skips a paired client whose Host owns the data.                                                                                 | `lib/files-library/trash-purge-schedule.ts`      |
| `harness-evolution-sweep`                     | Hourly tick                                | Installed by scheduler boot; launches queued runs only when background evolution is allowed, subject to launch interval, concurrency, and run budget.                                                                | `lib/harness/runtime/background.ts`              |
| `connection:housekeeping:clock`               | Every 24 h, plus boot sweep                | Connector runtime installs it and relays the daily event; boot/catch-up dispatches share a 5-min debounce.                                                                                                           | `lib/connectors/housekeeping-scheduler.ts`       |
| `connection:housekeeping:outbound-retention`  | Daily event                                | Removes terminal outbound rows.                                                                                                                                                                                      | Same housekeeping owner                          |
| `connection:housekeeping:callback-bindings`   | Daily event                                | Removes expired callback bindings.                                                                                                                                                                                   | Same housekeeping owner                          |
| `connection:housekeeping:execution-runs`      | Daily event                                | Removes expired execution-run events.                                                                                                                                                                                | Same housekeeping owner                          |
| `connection:housekeeping:connector-retention` | Daily event                                | Removes terminal inbound jobs and expired audit/heartbeat rows.                                                                                                                                                      | Same housekeeping owner                          |
| `connection:housekeeping:attachment-cache`    | Daily event                                | Retries cleanup ledger, reconciles orphan attachments, then enforces cache budget.                                                                                                                                   | Same housekeeping owner                          |
| `connection:presence:refresh`                 | Configured minutes; defaults to 5, floor 1 | Requires configured presence and an enabled adapter; settings removal deletes the schedule; adapter lifecycle preserves manual pauses.                                                                               | `lib/connectors/presence/usage-status-runner.ts` |
| `github-issue-sync`                           | Every 15 min, with 1-min jitter            | Singleton exists while external issue bindings exist. Despite the historical type name, also covers Lark tasklists/Bitables and other supported external bindings.                                                   | `lib/issues/github-sync-schedule.ts`             |

The first four are installed by `initSchedulerSystem` in
`lib/scheduler/index.ts`. The connector group is installed by
`lib/connectors/bootstrap/install-connector-runtime.ts`. Definition presence
does not imply the corresponding boot bundle is mounted on every host.

## 2. Feature-authored schedules

These are built-in capabilities, but do not represent unconditional maintenance.
Their number and cadence depend on saved settings or authored objects.

| Family                           | Schedule                                 | Creation condition and owner                                                                                             |
| -------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Twin ingest / distill (`twin`)   | User cron; up to two rows per twin       | Enabled Twin cron settings; `lib/twin/cron/cron-bridge.ts`                                                               |
| Wiki rebuild (`wiki-rebuild`)    | Daily 03:00, Sunday 03:00, or custom     | Wiki schedule mode is not off; `lib/wiki/schedule/cron-bridge.ts`                                                        |
| Wiki health check (`wiki-lint`)  | Same preset resolver as Wiki rebuild     | Lint schedule mode is not off; `lib/wiki/lint/lint-cron-bridge.ts`                                                       |
| Attention Radar (`radar-report`) | Daily 09:00, Monday 09:00, or custom     | Radar enabled and schedule mode not off; `lib/radar/radar-cron-bridge.ts`                                                |
| Bot timed triggers (`bot`)       | Manifest/configured interval or cron     | Enabled installation, trigger armed, and ownership local to this runtime; `lib/bot/schedule/reconcile-timed-triggers.ts` |
| Issue wakeups (`issue-wakeup`)   | Authored time/event conditions           | Issue-specific subscriptions; `lib/issues/wakeups/service.ts`                                                            |
| Connector sends/digests          | Authored schedule                        | `connection:outbound:send` / `connection:scheduled:digest`; `lib/connectors/scheduled-outbound.ts`                       |
| Plugin schedules (`plugin`)      | Manifest/user-defined supported triggers | Plugin scheduling capability and lifecycle; `lib/plugin/bridge/scheduled-task-bridge.ts`                                 |

Cron presets use the configured timezone when supplied; the displayed clock
times above do not imply a fixed Asia/Shanghai timezone.

The executor registry additionally supports chat, agent, skill, script,
background commands, monitors, backups, workflows, external agents, teams,
goals, plans, tests, and custom tasks. **An executor is not an installed timer.**
The 22 entries in `BUILT_IN_EXECUTOR_TASK_TYPES` must not be presented as 22
automatically enabled jobs.

## 3. Background loops outside the persisted task lifecycle

The following are confirmed implementation entry points. This is a bounded
inventory of product background work, not a count of every timer in the app;
request timeouts, transport keepalives, UI clocks, and lease renewals are excluded.

| Loop                                | Cadence / gate                                                                                     | Source                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Codex usage probe                   | Opt-in, desktop; visible 5 min / hidden 30 min by default; 60-s floor and additive jitter          | `lib/subscription/codex/scheduler.ts`, `types/subscription/usage.ts`       |
| Anthropic usage probe               | Same default cadence; opt-in, desktop; credential breaker; probes spend quota                      | `lib/subscription/anthropic/scheduler.ts`, `types/subscription/usage.ts`   |
| Provider OAuth renewal              | First check after 3 s, then 5 min plus jitter; only near-expiry credentials renew                  | `components/providers/initializers/provider-oauth-refresh-initializer.tsx` |
| Automatic backup / WebDAV check     | Initial check and every 30 min; actual backup depends on enabled configuration and due calculation | `lib/data/backup-scheduler.ts`                                             |
| Automation audit retention          | Initial check and every 24 h; re-reads retention days; web uses defaults                           | `lib/automation/audit-retention.ts`                                        |
| Storage retention                   | Initial check and every 24 h                                                                       | `lib/storage/retention.ts`                                                 |
| Memory job worker                   | Initial drain and every 30 s; durable jobs and drain lock decide actual work                       | `lib/memory/lifecycle/job-worker.ts`                                       |
| Memory daily maintenance enqueue    | Opportunistic post-turn idle trigger, day-bucket deduplication; not a wall-clock daily alarm       | `lib/memory/lifecycle/maintenance.ts`                                      |
| Twin job worker                     | Default 2-s polling, 500-ms floor while worker is running                                          | `lib/twin/job-worker.ts`                                                   |
| Online evaluation                   | Initial drain if policies exist, then 60-s checks; batch 20                                        | `lib/ai/eval/online/scheduler.ts`                                          |
| Collaboration refresh fallback      | Visible page, 60 s to 15 min backoff; live feed suppresses periodic pulls                          | `lib/collab/refresh-scheduler.ts`                                          |
| Connector SLA escalation            | Every 60 s after 15-s boot delay                                                                   | `lib/connectors/escalation/schedule.ts`                                    |
| Lark surfaces / bind-request expiry | Separate loops using the shared daily-schedule helper; configured by their owner                   | `lib/connectors/adapters/lark/surface-schedule.ts`                         |
| Plugin update / plugin backup       | Configurable update checks; backup implementation defaults to 24 h when enabled                    | `lib/plugin/lifecycle/updater.ts`, `lib/plugin/lifecycle/backup.ts`        |

Desktop React initializers and headless runtime registration differ. In
particular, the online-evaluation driver explicitly runs only in the renderer.
Do not infer headless support merely from a host-neutral function signature.

## 4. Implemented governance

### Live lifecycle writes

Twin, Wiki rebuild, Wiki lint, Radar, and external-issue synchronization now use
`saveManagedTask` / the live scheduler's create, update, and delete methods.
`CreateScheduledTaskInput.id` supports their existing stable singleton identities;
creation still uses an insert, so a duplicate ID cannot overwrite another row.
Updates retain history, counters, owner, and manual pause state. Changes to a
trigger recalculate and rearm its next live alarm. A stop during an asynchronous
update cannot revive the scheduler after the pending database read/write finishes.

### Silent internal upkeep

The shared maintenance policy covers provider diagnostics, conversation archive,
Files trash purge, Harness background sweep, connector housekeeping, connector
presence refresh, and external-issue cache synchronization. New tasks default to
all notification flags off, `dueReminder: false`, and `channels: ["none"]`.
Failures remain in execution history; they do not generate routine user alerts.
The periodic provider diagnostics clock also no longer sends OS notifications
through a separate direct path.

Existing inherited default-toast configurations are adopted at scheduler startup.
Explicit delivery channels and explicit due-reminder opt-ins are preserved.
Legacy records do not identify whether an unchanged default-toast configuration
was selected manually; that exact default shape is treated as inherited.

Pet execution broadcasts mark internal maintenance so they do not create activity,
speech, or reward signals. The native due-event source and reminder hook both
consult the shared classification and the task's explicit reminder preference.
User-authored reports, sends, digests, bot deliverables, approvals, and their
existing notification settings are not assigned the silent-maintenance default.

### Safe singleton reconciliation

Four scheduler-boot installers and six connector-housekeeping types share
`ensureMaintenanceSchedule`. New rows use deterministic IDs, repeated installation
is serialized per scheduler/type, and a concurrent primary-key winner is adopted
through the live clock. Existing canonical rows retain their cadence and manual
pause; extra local copies are disabled and tagged with the retained identity,
without deleting their execution history. Remote-host and plugin-authored rows
are excluded from local singleton consolidation. Notification migration skips
remote-host placeholders, whose mutation would otherwise fail ownership checks.

Presence remains per adapter, and Issues remains its existing fixed singleton;
they are not collapsed by the global-per-type maintenance installer.

`createdBy` retains its existing author-provenance contract (`user/agent/plugin`).
This patch does not reinterpret it as a subsystem-owner enum or require a database
migration. Internal policy uses the declared maintenance types and existing tags;
notification classification and executor capabilities remain separate concerns.

### Diagnostic state preservation

Boot atomically adds missing refresh sources instead of overwriting existing
states. Authentication pauses, server retry time, failure backoff, observations,
and notification cooldown survive repeated boots. A successful user-requested
reachability probe explicitly resumes its own authentication-paused refresh
source. It does not reactivate unrelated balance-source pauses. Ordinary restart
alone is no longer a retry signal.

## 5. Verification and limits

Regression tests first reproduced unarmed Twin/Wiki schedules and diagnostic
authentication state being reset. They passed after the lifecycle/state fixes.
The repository Jest entry point was used without coverage; an ENOSPC failure in
the shared temporary transform cache was avoided with `--no-cache`.

- Full focused regression run: 22 suites / 487 tests passed, including scheduler
  lifecycle, owners, notifications, cron bridges, maintenance, provider service,
  presence, and pet event/reminder paths.
- Final focused follow-up: 4 suites / 219 tests passed, covering diagnostic
  scheduled backoff across repeated boots, a failed maintenance execution retaining
  history without a notification, and cancellation both during the initial
  migration read and between migration updates.
- `pnpm lint`: passed. Scoped ESLint also passed with zero warnings.
- `pnpm typecheck`: still blocked by out-of-scope errors in session-summary,
  guild-rail, sidebar-nav-section, and plugin permission tests. No errors in the
  changed task paths appeared in the final run. The chained sidecar typecheck did
  not execute after the root checker failed.
- `pnpm lint:static-export`: blocked by the existing `node:fs/promises` import in
  `lib/browser/extension-engine.ts:450`, outside this change.
- Read-only wiring, PII, test-gap, and i18n audits ran. Their concrete task-owned
  findings were addressed; no new UI strings or locale keys were introduced.

No live Tauri/browser account schedules or production vendor calls were exercised.
UI layout did not change. No production static build was run with the independent
static-export violation unresolved. Background workers listed in section 3 keep
their existing lifecycle; this change does not force transport/lease timers into
user task rows or claim a complete background-runtime control UI.
