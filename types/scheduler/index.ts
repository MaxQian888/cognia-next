/**
 * Scheduler Type Definitions
 * Types for scheduled tasks, cron expressions, and task execution
 */

import type { BuiltinToolsConfig, SendOptions } from "@cognia/agent-config-types"
import type { AcpPermissionMode } from "@/types/agent/external-agent"
import type { GoalConfig } from "@/types/goal"

// Task trigger types
export type TaskTriggerType = "cron" | "interval" | "once" | "event"

// Task types that can be scheduled. Every variant listed here either has a
// registered executor (see `lib/scheduler/executors/index.ts` and the
// subsystem executors it names) or is one of the two DEPRECATED variants that
// stay in the enum only so persisted rows keep type-checking:
//   - `sync`          → deprecated: never had a backing system in cognia-next
//   - `ai-generation` → deprecated: fully overlapped by `chat`
// Deprecated rows are auto-paused at scheduler init and cannot be created
// (`lib/scheduler/host-support.ts:DEPRECATED_TASK_TYPES`). Which types can run
// on which host is declared in `TASK_TYPE_HOST_REQUIREMENTS` in the same
// module — executors no longer branch on `isTauri()`.
export type ScheduledTaskType =
  // Runs a published visual workflow via `executeDeployedWorkflow`
  // (`lib/scheduler/executors/workflow-executor.ts`).
  | "workflow"
  | "agent"
  /** @deprecated no executor; kept for persisted rows only. */
  | "sync"
  | "backup"
  | "custom"
  | "plugin"
  | "script"
  | "background-command"
  | "monitor"
  // Diagnostic executor that echoes its payload — validates the trigger chain
  // end-to-end (`lib/scheduler/executors/test-executor.ts`).
  | "test"
  /** @deprecated no executor; use `chat`. Kept for persisted rows only. */
  | "ai-generation"
  | "chat"
  // Pushes a message into a bound IM conversation through the governed
  // outbound queue (`lib/scheduler/executors/im-push-executor.ts`).
  | "im-push"
  | "skill"
  | "external-agent"
  // Built-in multi-agent runs (ADR-0022 / 0045). Executors registered in
  // `lib/scheduler/executors/index.ts` drive a whole Agent Team run, a
  // self-driving Goal loop, or an AgentPlan execution from a schedule.
  | "agent-team"
  | "goal"
  | "plan"
  // Twin subsystem registers `"twin"` via `registerTaskExecutor` in
  // `lib/scheduler/executors/twin-executor.ts`. Surfaced here so cron-
  // driven Twin ingest/distill rows are typed properly across the codebase.
  | "twin"
  // Connector subsystem registers two task-types via `registerTaskExecutor`
  // in `lib/connectors/scheduled-outbound.ts`. Listed here so connector rows
  // in the same `tasks` Dexie store are typed properly across the codebase.
  | "connection:scheduled:digest"
  | "connection:outbound:send"
  // One persisted daily clock fans out the three connector retention sweeps
  // through an event trigger. These remain scheduler task types rather than
  // growing TaskTriggerType with subsystem-specific timer variants.
  | "connection:housekeeping:clock"
  | "connection:housekeeping:outbound-retention"
  | "connection:housekeeping:connector-retention"
  | "connection:housekeeping:callback-bindings"
  | "connection:housekeeping:execution-runs"
  | "connection:housekeeping:attachment-cache"
  // Usage-presence refresh (token-usage status on IM platforms) — registered
  // in `lib/connectors/presence/usage-status-runner.ts`.
  | "connection:presence:refresh"
  // External Bridge subsystem registers `"wiki-rebuild"` via
  // `registerTaskExecutor` in `lib/scheduler/executors/wiki-rebuild-executor.ts`.
  // Listed here so cron-driven Wiki rebuild rows are typed properly.
  | "wiki-rebuild"
  // Wiki-lint (orphan / broken-link check) — registered in
  // `lib/scheduler/executors/wiki-lint-executor.ts`.
  | "wiki-lint"
  // GitHub issue mirror refresh for the `/issues` board — registered in
  // `lib/scheduler/executors/github-issue-sync-executor.ts`.
  | "github-issue-sync"
  // Attention Radar report — registered in
  // `lib/scheduler/executors/radar-report-executor.ts`.
  | "radar-report"
  // Free provider reachability and configured balance refresh only. The
  // executor is forbidden from scheduling paid generation/embedding jobs.
  | "provider-diagnostics-refresh"

// Task execution status
export type TaskExecutionStatus =
  "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped"

export type TaskExecutionTriggerSource =
  "schedule" | "run-now" | "retry" | "event" | "dependency" | "catch-up" | "remote" | "backfill"

export type TaskExecutionTerminalReason =
  | "completed"
  | "executor-failure"
  | "execution-error"
  | "execution-timeout"
  | "concurrency-blocked"
  | "retry-chain-active"
  | "missed-run-skipped"
  | "once-expired"
  | "retry-scheduled"
  | "overlap-skipped"
  | "overlap-cancelled"
  | "catchup-window-expired"
  | "max-runs-reached"
  | "ended"
  | "auto-paused"
  // The app restarted while this execution was still `running`/`pending`. Its
  // in-memory controller did not survive, so a boot reconcile cancels the
  // orphaned row instead of leaving it "running" forever (see
  // `SchedulerDatabase.interruptStaleExecutions`).
  | "interrupted-on-restart"
  // The executor refused to run because the host lacks a capability the task
  // type needs (`lib/scheduler/host-support.ts`); the execution `output`
  // carries the structured `hostSupport` reason.
  | "unsupported-on-host"
  // The task type is deprecated (`DEPRECATED_TASK_TYPES`); the scheduler
  // paused the task at init and wrote this row to explain why.
  | "deprecated-type"
  // No executor was registered for the task type when the run was due — even
  // after the boot registration grace period.
  | "executor-not-found"

/**
 * How a due fire interacts with an already-running execution of the same task.
 * Mirrors Temporal Schedule overlap policies:
 * - `allow`           start regardless (ALLOW_ALL)
 * - `skip`            drop the new start (SKIP)
 * - `queue-one`       keep at most one pending start, newest wins (BUFFER_ONE)
 * - `queue-all`       FIFO-buffer starts up to `maxQueueSize` (BUFFER_ALL)
 * - `cancel-previous` abort the running execution, then start (CANCEL_OTHER)
 */
export type TaskOverlapPolicy = "allow" | "skip" | "queue-one" | "queue-all" | "cancel-previous"

// Task status
export type ScheduledTaskStatus = "active" | "paused" | "disabled" | "expired"

/** Provenance used to scope agent/plugin mutations to tasks they created. */
export interface ScheduledTaskCreator {
  kind: "user" | "agent" | "plugin"
  /** Required for agent-authored tasks; identifies the owning chat session. */
  sessionId?: string
  /** Optional plugin id for plugin-authored tasks. */
  pluginId?: string
}

/**
 * Notification channels a task can request.
 *
 * `desktop` / `toast` / `im` are all delivered by the Unified Notification
 * Center (ADR-0042) — this union is the scheduler's own vocabulary and MUST stay
 * mappable onto `types/notifications`'s `NotificationChannel`. `im` was missing
 * for a long time even though the center, the delivery implementation
 * (`lib/notifications/im-deliver.ts`) and the per-conversation opt-in all
 * existed: the narrower union here was the only thing blocking it, so a task
 * result could not reach a chat window without authoring a second
 * `connection:*` task by hand.
 *
 * `webhook` is different — a scheduler-owned outbound HTTP integration, not a
 * user-facing notification, dispatched directly.
 */
export type NotificationChannel = "desktop" | "toast" | "webhook" | "im" | "none"

export type BackupTaskType = "full" | "sessions" | "settings" | "plugins" | "all"

/**
 * Backup targets. `local` / `webdav` / `github` / `googledrive` have wired
 * uploaders (`lib/data/destinations/`); `all` = local + every remote.
 * `convex` is DEPRECATED — kept only so persisted rows keep type-checking;
 * the executor refuses it with a clear message and the UI never offers it.
 */
export type BackupDestination = "local" | "webdav" | "github" | "googledrive" | "convex" | "all"

export interface BackupSelectionOptions {
  includeSessions?: boolean
  includeSettings?: boolean
  includeArtifacts?: boolean
  includeIndexedDB?: boolean
}

export interface BackupTaskPayload extends Record<string, unknown> {
  backupType?: BackupTaskType
  destination?: BackupDestination
  options?: BackupSelectionOptions
}

/**
 * Payload for `wiki-rebuild` scheduled tasks. The schedule UI in
 * `components/settings/external-bridge/wiki-rebuild-card.tsx` creates one
 * task with this payload; the executor in
 * `lib/scheduler/executors/wiki-rebuild-executor.ts` calls
 * `runWikiRebuild({ force })` on each fire.
 */
export interface WikiRebuildTaskPayload extends Record<string, unknown> {
  /** When true, ignore cached hashes and re-process every file. */
  force?: boolean
  /**
   * Root directory to walk. Defaults to `.` (the process cwd) on the desktop.
   * On the headless brain the host's workspace-root policy applies, so this
   * must be an absolute path under the configured workspaces root.
   */
  rootDir?: string
}

/**
 * Payload for `workflow` tasks — runs a published visual workflow through the
 * canonical admission ingress (`executeDeployedWorkflow`,
 * `lib/workflow/runtime/execution-authority.ts`) with
 * `entrypoint: "schedule"` / `triggeredBy.source: "schedule"`. The workflow
 * must have an active deployment in `environment` (default `production`).
 */
export interface WorkflowTaskPayload extends Record<string, unknown> {
  /** Required. Id of the workflow (`workflows` table). */
  workflowId: string
  /** Deployment environment; defaults to `production`. */
  environment?: string
  /** Trigger input handed to the run as its payload. */
  inputs?: unknown
  /**
   * Trigger node to enter through. When set, the run is admitted with
   * `triggerKind: "trigger.cron"` bound to this node; when omitted the run
   * enters through the manual trigger.
   */
  triggerId?: string
  /**
   * Idempotency key so a re-fired slot does not start a second run of the
   * same logical invocation. Defaults to `<taskId>:<executionId>`.
   */
  idempotencyKey?: string
}

/**
 * Payload for `im-push` tasks — pushes a message into an already-bound IM
 * conversation through the governed outbound queue
 * (`lib/scheduler/executors/im-push-executor.ts`). Exactly one of `text` /
 * `segments` is required; `text` is wrapped as a single text segment.
 * `adapterId` is derived from the persisted conversation delivery target, so
 * the payload only names the conversation.
 */
export interface ImPushTaskPayload extends Record<string, unknown> {
  /** Required. Canonical connector conversation key. */
  conversationKey: string
  /** Plain-text body (wrapped into one text segment). */
  text?: string
  /** Pre-built rich segments; takes precedence over `text` when both are set. */
  segments?: import("@/types/connectors/segment").MessageSegment[]
  /** Idempotency key for the outbound job; defaults to `<taskId>:<executionId>`. */
  idempotencyKey?: string
}

/**
 * Payload for `test` tasks — a diagnostic executor that proves the trigger →
 * execution → notification chain without side effects. `echo` is copied into
 * the execution output, `delayMs` sleeps (abortable) before completing, and
 * `failWith` makes the run fail with that message so error notifications and
 * retry policies can be exercised deliberately.
 */
export interface TestTaskPayload extends Record<string, unknown> {
  echo?: unknown
  delayMs?: number
  failWith?: string
}

/**
 * Result contract every task executor returns. `terminalReason` is optional
 * and lets an executor override the scheduler's default mapping
 * (`completed` / `executor-failure`) with a structured reason — used by the
 * host gate (`unsupported-on-host`).
 */
export interface TaskExecutorResult {
  success: boolean
  output?: Record<string, unknown>
  error?: string
  terminalReason?: TaskExecutionTerminalReason
}

export type ScheduledTaskPayload =
  | Record<string, unknown>
  | BackupTaskPayload
  | WikiRebuildTaskPayload
  | TestTaskPayload
  | WorkflowTaskPayload
  | ImPushTaskPayload
  | BackgroundCommandTaskPayload
  | MonitorTaskPayload
  | ChatLikeTaskPayload
  | AgentTaskPayload
  | SkillTaskPayload
  | ExternalAgentTaskPayload
  | AgentTeamTaskPayload
  | GoalTaskPayload
  | PlanTaskPayload

export interface BackgroundCommandTaskPayload extends Record<string, unknown> {
  command: string
  cwd: string
  label?: string
}

export interface MonitorTaskPayload extends Record<string, unknown> {
  condition: import("@/lib/jobs/background-jobs").BackgroundMonitorCondition
  /** ISO date or epoch milliseconds. Omit to keep the watch until it settles. */
  expiresAt?: string | number
  label?: string
}

/**
 * Common payload shape for any task that drives a Claude turn through the
 * sidecar (chat / agent / skill). Mirrors the knobs `resolveSendOptions`
 * already understands so a scheduled run reaches feature parity with an
 * interactive turn (character / agent mode / skills / tools / MCP / built-in
 * tools / permission mode / additional dirs / max turns / effort / resume).
 *
 * The executor layers payload-level overrides on top of the base resolution
 * (see `lib/scheduler/executors/index.ts`). `allowedTools` and
 * `additionalDirectories` are *unioned* with the resolved set; the rest are
 * direct overrides. Leave a field undefined to defer to the resolved value.
 */
export interface ChatLikeTaskPayload extends Record<string, unknown> {
  /** Required. The user-turn content sent to the sidecar. */
  prompt: string
  /** Append to an existing session instead of creating a new one. */
  sessionId?: string
  /** Title used when the executor creates a new session for this run. */
  sessionTitle?: string
  /** When set, the scheduler creates a `kind: "team"` session bound to this team. */
  teamId?: string
  /**
   * Uses the same durable execution identity as an interactive chat. A
   * managed-worktree request is mandatory for unattended setup: scheduled
   * runs may retry initialization, but never bypass a failed setup script.
   */
  executionContext?: import("@/types/execution-context").SessionExecutionContext

  /** Override the model picked by character / mode / app default. */
  model?: string
  /**
   * Apply a specific built-in or custom agent mode to this run.
   * - undefined → fall through to `useAgentRuntimeStore.modeId` at run time
   * - null      → opt OUT of mode application entirely (raw character + skills)
   * - string    → look up by id in built-in then custom mode registries
   */
  agentModeId?: string | null
  /** SDK permission mode override. */
  permissionMode?: SendOptions["permissionMode"]
  /** Tools to UNION onto the resolved allowedTools whitelist. */
  allowedTools?: string[]
  /** Tools to add to the disallow list (replaces resolved value when set). */
  disallowedTools?: string[]
  /** Subset of MCP server ids to use (replaces character/team subset when set). */
  mcpServerIds?: string[]
  /** Extra directories the SDK may read from (UNIONED with resolved value). */
  additionalDirectories?: string[]
  /** Patches `appSettings.builtinTools` for this run only. */
  builtinTools?: Partial<BuiltinToolsConfig>
  /** Appended to the system prompt (sidecar `appendSystemPrompt`). */
  appendSystemPrompt?: string
  /** Hard cap on agentic turns inside the SDK invocation. */
  maxTurns?: number
  /** SDK effort level. */
  effort?: SendOptions["effort"]
  /** Skill ids to disable for this run, in addition to `session.disabledSkillIds`. */
  disabledSkillIds?: string[]
}

/** Payload for `agent` task type — a chat-like turn bound to a specific character. */
export interface AgentTaskPayload extends ChatLikeTaskPayload {
  /** Required. The character (a.k.a. agent persona) that drives the reply. */
  characterId: string
  /** Optional durable single-Agent board card owning this execution attempt. */
  agentTaskId?: string
}

/**
 * Payload for `skill` task type — a chat-like turn that activates one
 * additional skill for the run. The character's own `skillIds` still apply.
 */
export interface SkillTaskPayload extends ChatLikeTaskPayload {
  /** Required. Skill to enable on top of the character's skill set. */
  skillId: string
}

/**
 * Payload for `external-agent` task type — drives an ACP agent (Claude
 * Desktop / Cursor / Codex / Gemini / …). Uses
 * `lib/ai/agent/external/manager.ts:executeOnExternalAgent` under the hood.
 */
export interface ExternalAgentTaskPayload extends Record<string, unknown> {
  /** Required. The user-turn content sent to the external agent. */
  prompt: string
  /** Required. ExternalAgentConfig.id of the configured ACP agent. */
  agentId: string
  /** ACP permission mode override (defaults to the agent's configured mode). */
  permissionMode?: AcpPermissionMode
  /** Working directory for the ACP session. */
  cwd?: string
  /** Per-task timeout (ms). When omitted, falls back to task.config.timeout. */
  timeoutMs?: number
}

/**
 * Payload for `agent-team` task type — runs a whole Agent Team to terminal
 * via `agentTeamManager.start` (ADR-0022). The team must already exist in the
 * team store (live teams are not persisted across an app restart — schedule a
 * team only within a running session, or persist its definition first).
 */
export interface AgentTeamTaskPayload extends Record<string, unknown> {
  /** Required. The id of an existing AgentTeam to run. */
  teamId: string
  /** Force ultracode orchestration for this run (defaults to the team's autoMode). */
  ultracode?: boolean
}

/**
 * Payload for `goal` task type — creates a self-driving `/goal` in a fresh (or
 * supplied) background session and drives its turn loop to terminal headlessly
 * (ADR-0019). Bounded by the goal's own exit conditions (turns / budget /
 * timeout / judge). The objective is PII-redacted before it reaches the model.
 */
export interface GoalTaskPayload extends Record<string, unknown> {
  /** Required. The objective the goal pursues (redacted before model use). */
  objective: string
  /** Character (agent persona) that drives the loop. */
  characterId?: string
  /** Append to an existing session instead of creating a fresh background one. */
  sessionId?: string
  /** Title used when the executor creates a new session for this run. */
  sessionTitle?: string
  /** Per-goal config overrides (maxTurns / maxTokens / timeoutMs / judge…). */
  config?: Partial<GoalConfig>
}

/**
 * Payload for `plan` task type — executes an existing AgentPlan via
 * `getPlanRuntime().runPlan` (ADR-0045). Plans persist in Dexie, so `planId`
 * survives an app restart.
 */
export interface PlanTaskPayload extends Record<string, unknown> {
  /** Required. The id of an approved/paused AgentPlan to run. */
  planId: string
  /** When true, a step failure triggers a capped auto-replan (needs an LLM client). */
  replanOnFailure?: boolean
}

/**
 * Cron expression parts for validation and display.
 *
 * `seconds` is optional and only populated for 6-field expressions (the
 * OCPS/`cron-parser@5` "seconds minute hour dom month dow" form). 5-field
 * expressions leave it `undefined`, so existing 5-field round-trips through
 * `parseCronExpression` → `formatCronExpression` stay byte-identical.
 */
export interface CronParts {
  /** Optional leading seconds field (6-field expressions only). */
  seconds?: string
  minute: string
  hour: string
  dayOfMonth: string
  month: string
  dayOfWeek: string
}

/**
 * Cron preset for quick selection
 */
export interface CronPreset {
  id: string
  label: string
  labelZh: string
  expression: string
  description: string
}

export interface CronExpressionOption {
  id: string
  label: string
  value: string
  description?: string
}

/**
 * Task trigger configuration
 */
export interface TaskTrigger {
  type: TaskTriggerType
  /** Cron expression (for 'cron' type) */
  cronExpression?: string
  /** Interval in milliseconds (for 'interval' type) */
  intervalMs?: number
  /** Specific time to run (for 'once' type) */
  runAt?: Date
  /** Event type to listen for (for 'event' type) */
  eventType?: string
  /** Event source filter */
  eventSource?: string
  /** Timezone for cron expressions */
  timezone?: string
  /** Task IDs that must complete successfully before this task runs */
  dependsOn?: string[]
  /**
   * Max random delay (ms) added to the *armed* fire time of cron/interval
   * triggers to avoid thundering herds. The canonical slot (`nextRunAt`,
   * `scheduledFor`, missed-run math) is never jittered.
   */
  jitterMs?: number
}

/**
 * Task notification configuration
 */
export interface TaskNotificationConfig {
  /** Notify when task starts */
  onStart: boolean
  /** Notify when task completes successfully */
  onComplete: boolean
  /** Notify when task fails */
  onError: boolean
  /** Notify on progress (for long-running tasks) */
  onProgress?: boolean
  /** Notification channels to use */
  channels?: NotificationChannel[]
  /** Webhook URL for webhook notifications */
  webhookUrl?: string
  /**
   * Where the `im` channel delivers. Layer 1 of two: when unset (or when the
   * conversation no longer resolves) delivery falls back to the global ops
   * channel in `AppSettings.schedulerNotifications.fallbackConversationKey`, so
   * a failing task can still reach someone after its original chat is gone.
   *
   * Only the conversation key is stored. The adapter is derived from the bound
   * session's `platformBinding` at delivery time (`im-deliver.ts`) — persisting
   * it here too would be a second source of truth that goes stale when a
   * conversation is re-bound to another bot.
   *
   * Tasks authored from IM get this filled in with their originating
   * conversation. Serialized inside the task's `notification` JSON blob, so
   * adding it needs no Dexie version.
   */
  imTarget?: { conversationKey: string }
}

/**
 * Task execution configuration
 */
export interface TaskExecutionConfig {
  /** Maximum execution time in milliseconds */
  timeout: number
  /** Number of retry attempts on failure */
  maxRetries: number
  /** Base delay between retries in milliseconds (used with exponential backoff) */
  retryDelay: number
  /** Maximum retry delay in milliseconds (caps exponential backoff) */
  maxRetryDelay?: number
  /** Whether to run missed executions on startup */
  runMissedOnStartup: boolean
  /** Maximum number of missed executions to run */
  maxMissedRuns?: number
  /**
   * Whether to allow concurrent executions.
   * @deprecated Superseded by `overlapPolicy`; kept for persisted-task
   * back-compat (`true` → "allow", `false` → "skip"). The scheduler reads
   * `overlapPolicy` first.
   */
  allowConcurrent?: boolean
  /** Overlap policy applied when a fire collides with a running execution. */
  overlapPolicy?: TaskOverlapPolicy
  /** Max buffered starts for `queue-all` (overflow is dropped as "overlap-skipped"). */
  maxQueueSize?: number
  /** Auto-expire the task after this many total runs (failures count). */
  maxRuns?: number
  /** Auto-pause the task after this many consecutive terminal failures. */
  pauseAfterConsecutiveFailures?: number
  /**
   * Time window (ms) for catch-up: missed slots older than this are skipped
   * with reason "catchup-window-expired" instead of being re-run.
   */
  catchupWindowMs?: number
}

/**
 * OS-level promotion record (desktop only). While present, the app scheduler
 * does NOT arm this task itself: the OS scheduler (launchd / Task Scheduler /
 * systemd) fires an `open_url` action for `cognia://scheduler/task/<id>?run=<token>`,
 * the desktop deep-link handler verifies `token` and runs the task through
 * the normal execution path (`triggerSource: "run-now"`). Un-promoting deletes
 * the OS task and re-arms the app trigger. Serialized inside the task row as
 * JSON, so it needs no SchedulerDB version bump.
 */
export interface ScheduledTaskPromotion {
  /** OS scheduler task id (`SystemTaskId`). */
  systemTaskId: string
  /**
   * Random secret embedded in the wake-up deep link. Only a link carrying this
   * exact token may run the task; a plain `cognia://scheduler/task/<id>` link
   * (e.g. from a web page) only navigates. Never shown in the UI.
   */
  token: string
  promotedAt: Date
  /** OS backend that holds the task (`launchd` / `Task Scheduler` / `systemd`). */
  backend?: string
}

/**
 * Scheduled task definition
 */
export interface ScheduledTask {
  id: string
  name: string
  description?: string
  type: ScheduledTaskType
  trigger: TaskTrigger
  payload?: ScheduledTaskPayload
  config: TaskExecutionConfig
  notification: TaskNotificationConfig
  status: ScheduledTaskStatus
  /**
   * Who authored this task. Rows created before scheduler schema v3 are
   * backfilled to `{ kind: "user" }`.
   */
  createdBy?: ScheduledTaskCreator
  /**
   * Owning workspace — a SOFT foreign key onto the main database's `projects`
   * table, which this database cannot reference (the scheduler has its own
   * Dexie instance on purpose).
   *
   * A schedule belongs to the work it was set up for. Without this it had only
   * a free-text `cwd` in its payload, so it could not be listed per workspace,
   * could not resolve its execution root the way an interactive turn does, and
   * fired against whatever directory the string happened to name.
   *
   * Undefined on rows that predate scheduler schema v5 and have no owning
   * session to inherit from — treated as "belongs to every workspace" rather
   * than guessed at, since a guess would silently rebind someone's schedule.
   */
  projectId?: string
  /** Tags for categorization */
  tags?: string[]
  /** Auto-expire the task once this instant passes (checked lazily at arm/fire). */
  endAt?: Date
  /** Present while the task is promoted to the OS scheduler (desktop only). */
  promotion?: ScheduledTaskPromotion
  /** Forward chain: tasks fired (fire-and-forget) after a successful run. */
  onSuccessTaskIds?: string[]
  /** Forward chain: tasks fired (fire-and-forget) after a terminal failure. */
  onFailureTaskIds?: string[]
  /** Consecutive terminal failures since the last success (drives auto-pause). */
  consecutiveFailures?: number
  /** Last execution time */
  lastRunAt?: Date
  /** Next scheduled execution time */
  nextRunAt?: Date
  /** Total number of executions */
  runCount: number
  /** Number of successful executions */
  successCount: number
  /** Number of failed executions */
  failureCount: number
  /** Last error message */
  lastError?: string
  /** Most recent terminal outcome reason */
  lastTerminalReason?: TaskExecutionTerminalReason | string
  /** Timestamp of most recent terminal outcome */
  lastTerminalAt?: Date
  createdAt: Date
  updatedAt: Date
}

/**
 * Task execution record
 */
export interface TaskExecution {
  id: string
  taskId: string
  taskName: string
  taskType: ScheduledTaskType
  status: TaskExecutionStatus
  input?: ScheduledTaskPayload
  output?: Record<string, unknown>
  error?: string
  /** Retry attempt number (0 = first attempt) */
  retryAttempt: number
  /** Execution duration in milliseconds */
  duration?: number
  /** Scheduled execution slot (if execution was schedule-bound) */
  scheduledFor?: Date
  /** What initiated this execution */
  triggerSource?: TaskExecutionTriggerSource
  /** Structured terminal outcome reason */
  terminalReason?: TaskExecutionTerminalReason | string
  /** Timestamp when a retry attempt was scheduled */
  retryScheduledAt?: Date
  startedAt: Date
  completedAt?: Date
  /** Logs from execution */
  logs: TaskExecutionLog[]
}

/**
 * Task execution log entry
 */
export interface TaskExecutionLog {
  id: string
  timestamp: Date
  level: "debug" | "info" | "warn" | "error"
  message: string
  data?: unknown
}

/**
 * Input for creating a scheduled task
 */
export interface CreateScheduledTaskInput {
  name: string
  description?: string
  type: ScheduledTaskType
  trigger: TaskTrigger
  payload?: ScheduledTaskPayload
  config?: Partial<TaskExecutionConfig>
  notification?: Partial<TaskNotificationConfig>
  createdBy?: ScheduledTaskCreator
  /**
   * Owning workspace. Omitted, it is resolved at creation — from the creating
   * conversation's workspace when `createdBy.sessionId` names one, otherwise
   * from the active workspace.
   */
  projectId?: string
  /**
   * "Attribution was already attempted; an absent `projectId` is the answer."
   *
   * `SchedulerDataSource` resolves the workspace at the UI boundary, where the
   * active workspace is a legitimate fallback. Without this, a resolution that
   * legitimately came back empty made the scheduler run the same
   * main-database lookup a second time under the same timeout budget — up to
   * twice `WORKSPACE_LOOKUP_TIMEOUT_MS` before task creation returned.
   *
   * Transient: consumed at creation, never stored on the task.
   */
  workspaceResolved?: boolean
  tags?: string[]
  endAt?: Date
  onSuccessTaskIds?: string[]
  onFailureTaskIds?: string[]
}

/**
 * Input for updating a scheduled task
 */
export interface UpdateScheduledTaskInput {
  name?: string
  description?: string
  trigger?: Partial<TaskTrigger>
  payload?: ScheduledTaskPayload
  config?: Partial<TaskExecutionConfig>
  notification?: Partial<TaskNotificationConfig>
  status?: ScheduledTaskStatus
  tags?: string[]
  endAt?: Date | null
  onSuccessTaskIds?: string[]
  onFailureTaskIds?: string[]
}

/**
 * Task filter options
 */
export interface TaskFilter {
  types?: ScheduledTaskType[]
  statuses?: ScheduledTaskStatus[]
  /** Single status shorthand filter */
  status?: ScheduledTaskStatus
  tags?: string[]
  search?: string
  /**
   * Restrict to one workspace. Rows with NO workspace always pass — they are
   * unattributed rather than foreign, and hiding them would make a schedule
   * that predates the column invisible everywhere at once.
   */
  projectId?: string
}

/**
 * Task statistics
 */
export interface TaskStatistics {
  totalTasks: number
  activeTasks: number
  pausedTasks: number
  totalExecutions: number
  successfulExecutions: number
  failedExecutions: number
  averageDuration: number
  upcomingExecutions: number
}

/**
 * Default execution configuration
 */
export const DEFAULT_EXECUTION_CONFIG: TaskExecutionConfig = {
  timeout: 300000, // 5 minutes
  maxRetries: 3,
  retryDelay: 5000, // 5 seconds base delay
  maxRetryDelay: 60000, // 1 minute cap for exponential backoff
  runMissedOnStartup: false,
  maxMissedRuns: 1,
  allowConcurrent: false,
  overlapPolicy: "skip",
  maxQueueSize: 10,
}

/**
 * Default notification configuration
 */
export const DEFAULT_NOTIFICATION_CONFIG: TaskNotificationConfig = {
  onStart: false,
  onComplete: true,
  onError: true,
  onProgress: false,
  channels: ["toast"],
}

/**
 * Common cron presets
 */
export const CRON_PRESETS: CronPreset[] = [
  {
    id: "every-minute",
    label: "Every minute",
    labelZh: "每分钟",
    expression: "* * * * *",
    description: "Runs every minute",
  },
  {
    id: "every-5-minutes",
    label: "Every 5 minutes",
    labelZh: "每5分钟",
    expression: "*/5 * * * *",
    description: "Runs every 5 minutes",
  },
  {
    id: "every-15-minutes",
    label: "Every 15 minutes",
    labelZh: "每15分钟",
    expression: "*/15 * * * *",
    description: "Runs every 15 minutes",
  },
  {
    id: "every-30-minutes",
    label: "Every 30 minutes",
    labelZh: "每30分钟",
    expression: "*/30 * * * *",
    description: "Runs every 30 minutes",
  },
  {
    id: "every-hour",
    label: "Every hour",
    labelZh: "每小时",
    expression: "0 * * * *",
    description: "Runs at the start of every hour",
  },
  {
    id: "every-2-hours",
    label: "Every 2 hours",
    labelZh: "每2小时",
    expression: "0 */2 * * *",
    description: "Runs every 2 hours",
  },
  {
    id: "every-6-hours",
    label: "Every 6 hours",
    labelZh: "每6小时",
    expression: "0 */6 * * *",
    description: "Runs every 6 hours",
  },
  {
    id: "every-12-hours",
    label: "Every 12 hours",
    labelZh: "每12小时",
    expression: "0 */12 * * *",
    description: "Runs every 12 hours",
  },
  {
    id: "daily-midnight",
    label: "Daily at midnight",
    labelZh: "每天午夜",
    expression: "0 0 * * *",
    description: "Runs daily at 00:00",
  },
  {
    id: "daily-6am",
    label: "Daily at 6am",
    labelZh: "每天早上6点",
    expression: "0 6 * * *",
    description: "Runs daily at 06:00",
  },
  {
    id: "daily-9am",
    label: "Daily at 9am",
    labelZh: "每天早上9点",
    expression: "0 9 * * *",
    description: "Runs daily at 09:00",
  },
  {
    id: "daily-noon",
    label: "Daily at noon",
    labelZh: "每天中午",
    expression: "0 12 * * *",
    description: "Runs daily at 12:00",
  },
  {
    id: "daily-6pm",
    label: "Daily at 6pm",
    labelZh: "每天下午6点",
    expression: "0 18 * * *",
    description: "Runs daily at 18:00",
  },
  {
    id: "weekdays-9am",
    label: "Weekdays at 9am",
    labelZh: "工作日早上9点",
    expression: "0 9 * * 1-5",
    description: "Runs Monday to Friday at 09:00",
  },
  {
    id: "weekly-monday",
    label: "Every Monday at 9am",
    labelZh: "每周一早上9点",
    expression: "0 9 * * 1",
    description: "Runs every Monday at 09:00",
  },
  {
    id: "weekly-sunday",
    label: "Every Sunday at midnight",
    labelZh: "每周日午夜",
    expression: "0 0 * * 0",
    description: "Runs every Sunday at 00:00",
  },
  {
    id: "monthly-first",
    label: "First day of month",
    labelZh: "每月第一天",
    expression: "0 0 1 * *",
    description: "Runs on the 1st of every month at 00:00",
  },
  {
    id: "monthly-15th",
    label: "15th of month",
    labelZh: "每月15日",
    expression: "0 0 15 * *",
    description: "Runs on the 15th of every month at 00:00",
  },
]

/**
 * Timezone options
 */
export const TIMEZONE_OPTIONS = [
  { value: "UTC", label: "UTC", offset: "+00:00" },
  { value: "Asia/Shanghai", label: "China Standard Time (Shanghai)", offset: "+08:00" },
  { value: "Asia/Tokyo", label: "Japan Standard Time (Tokyo)", offset: "+09:00" },
  { value: "Asia/Seoul", label: "Korea Standard Time (Seoul)", offset: "+09:00" },
  { value: "Asia/Singapore", label: "Singapore Time", offset: "+08:00" },
  { value: "America/New_York", label: "Eastern Time (New York)", offset: "-05:00" },
  { value: "America/Chicago", label: "Central Time (Chicago)", offset: "-06:00" },
  { value: "America/Denver", label: "Mountain Time (Denver)", offset: "-07:00" },
  { value: "America/Los_Angeles", label: "Pacific Time (Los Angeles)", offset: "-08:00" },
  { value: "Europe/London", label: "British Time (London)", offset: "+00:00" },
  { value: "Europe/Paris", label: "Central European Time (Paris)", offset: "+01:00" },
  { value: "Europe/Berlin", label: "Central European Time (Berlin)", offset: "+01:00" },
  { value: "Australia/Sydney", label: "Australian Eastern Time (Sydney)", offset: "+10:00" },
]

export function getCronExpressionOptions(limit?: number): CronExpressionOption[] {
  const presets = typeof limit === "number" ? CRON_PRESETS.slice(0, limit) : CRON_PRESETS
  return presets.map((preset) => ({
    id: preset.id,
    label: preset.label,
    value: preset.expression,
    description: preset.description,
  }))
}

// ============================================================================
// Permission types
// ============================================================================

/** Source that initiated task creation */
export type TaskCreationSource = "user" | "agent" | "plugin" | "system"

/**
 * App-wide defaults applied when a new scheduled task is created without
 * a per-task override. Stored on the policy so users can configure
 * "what every new task should look like by default" in the settings UI.
 */
export interface TaskDefaults {
  /** Default IANA timezone applied to new tasks. */
  timezone?: string
  /** Default notification settings (channels, webhook, etc.). */
  notification?: Partial<TaskNotificationConfig>
  /** Default execution settings (timeout, retries, concurrency). */
  execution?: Partial<TaskExecutionConfig>
}

/**
 * Permission policy for the app-level scheduler.
 * Controls what agents and plugins can do with scheduled tasks.
 */
export interface SchedulerPermissionPolicy {
  /** Whether agents can create tasks without user confirmation dialog */
  agentAutoCreate: boolean
  /** Task types that always require explicit user confirmation before creation */
  confirmationRequired: ScheduledTaskType[]
  /** Whether script-type tasks are allowed at all */
  scriptTasksEnabled: boolean
  /** Maximum number of tasks that can exist per creation source */
  maxTasksPerSource: number
  /** Maximum number of concurrent task executions globally */
  maxConcurrentExecutions: number
  /** Defaults applied when creating new tasks; per-task settings override. */
  taskDefaults?: TaskDefaults
}

export const DEFAULT_PERMISSION_POLICY: SchedulerPermissionPolicy = {
  agentAutoCreate: false,
  confirmationRequired: ["script", "agent", "goal", "agent-team"],
  scriptTasksEnabled: true,
  maxTasksPerSource: 50,
  maxConcurrentExecutions: 5,
}

// Re-export system scheduler types with aliased names to avoid conflicts
export {
  // Types
  type SystemTaskId,
  type RunLevel,
  type SystemTaskStatus,
  type RiskLevel,
  type TaskOperation,
  type CronTrigger as SystemCronTrigger,
  type IntervalTrigger as SystemIntervalTrigger,
  type OnceTrigger as SystemOnceTrigger,
  type OnBootTrigger,
  type OnLogonTrigger,
  type OnEventTrigger,
  type SystemTaskTrigger,
  type ExecuteScriptAction,
  type RunCommandAction,
  type LaunchAppAction,
  type SystemTaskAction,
  type TaskRunResult,
  type SystemTask,
  type CreateSystemTaskInput,
  type TaskConfirmationDetails,
  type TaskConfirmationRequest,
  type SchedulerCapabilities,
  type ValidationResult,
  type TaskOperationResponse,
  // Constants
  DEFAULT_SCRIPT_SETTINGS,
  SCRIPT_LANGUAGES,
  RISK_LEVEL_INFO,
  // Functions
  isTaskOperationSuccess,
  isConfirmationRequired,
  isTaskOperationError,
} from "./system-scheduler"

// Task dependency graph model (derived from `trigger.dependsOn[]`).
export type { DependencyNode, DependencyEdge, DependencyGraph } from "./dependency"

// Pluggable timing-source contracts (Rust alarm daemon vs renderer timers).
export type {
  SchedulerTimingDriver,
  LeaderAwareTimingDriver,
  TaskDueCallback,
  DaemonTaskDueEvent,
} from "./daemon"
