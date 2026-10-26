/**
 * Plugin Scheduler Types
 *
 * Type definitions for the plugin scheduler API
 */

// =============================================================================
// Task Trigger Types
// =============================================================================

export interface CronTrigger {
  type: "cron"
  expression: string
  timezone?: string
}

export interface IntervalTrigger {
  type: "interval"
  seconds: number
  /**
   * Run once as soon as the task is created, then every `seconds` from that
   * run. The scheduler's interval trigger has no such flag, so `createTask`
   * honours it by starting the first run itself (`triggerSource: "schedule"`);
   * the next slot is then measured from that run, exactly as for any interval
   * run. It applies at creation only: pausing, resuming or re-pointing the
   * trigger with `updateTask` does not fire an extra run. Stored on the task
   * and reported back on `PluginScheduledTask.trigger`, and reflected by
   * `previewTrigger`, whose first instant is "now" when it is set.
   */
  startImmediately?: boolean
}

export interface OnceTrigger {
  type: "once"
  runAt: Date | string
}

export interface EventTrigger {
  type: "event"
  eventType: string
  eventSource?: string
}

export type PluginTaskTrigger = CronTrigger | IntervalTrigger | OnceTrigger | EventTrigger

// =============================================================================
// Task Status & Result Types
// =============================================================================

/**
 * A plugin task's status, derived from the scheduler row rather than stored.
 *
 * - `active`    armed and healthy.
 * - `error`     armed, but its last terminal run failed (`consecutiveFailures`
 *               above zero). A retry still in flight does not count until it
 *               gives up, which is the moment the scheduler counts it too.
 * - `paused`    paused by the plugin, the user, or auto-pause after
 *               `pauseAfterConsecutiveFailures` (see `lastTerminalReason`).
 * - `disabled`  disabled by the host.
 * - `completed` finished on purpose: a `once` trigger that ran, or a task
 *               that consumed its `maxRuns` budget.
 * - `expired`   stopped by a bound rather than by finishing: `endAt` passed,
 *               or a `once` slot was missed and never ran.
 */
export type PluginTaskStatus = "active" | "paused" | "disabled" | "completed" | "error" | "expired"

/**
 * Every state an execution row of a plugin task can be in. Mirrors the
 * scheduler's `TaskExecutionStatus`, plus `timeout`, which is a `failed` run
 * whose terminal reason was the task's `timeout` elapsing. `pending` is a start
 * the overlap policy or the host's concurrency cap buffered; `skipped` is a
 * start that ended without running (overlap `skip`, a full `queue-all`
 * buffer, the concurrency cap).
 */
export type PluginTaskExecutionStatus =
  "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped" | "timeout"

/**
 * How a fire that collides with a running execution of the same task is
 * handled. Mirrors the scheduler's `TaskOverlapPolicy`:
 * `allow` runs both, `skip` drops the new start (the default), `queue-one`
 * keeps the newest pending start, `queue-all` buffers up to `maxQueueSize`,
 * `cancel-previous` aborts the running one.
 */
export type PluginTaskOverlapPolicy =
  "allow" | "skip" | "queue-one" | "queue-all" | "cancel-previous"

/**
 * What a handler returns, and what the host reports back for a settled run
 * (`PluginTaskExecution.result`, `PluginScheduledTask.lastResult`). `metrics`
 * survives the round trip: the executor records it on the execution's log.
 */
export interface PluginTaskResult {
  success: boolean
  output?: Record<string, unknown>
  error?: string
  metrics?: {
    duration?: number
    itemsProcessed?: number
    [key: string]: unknown
  }
}

/**
 * `data.kind` of the execution log entry the plugin executor writes for a
 * handler's `metrics`, which is how they survive into
 * `PluginTaskExecution.result` (the scheduler's execution row has no column
 * for them).
 */
export const PLUGIN_TASK_METRICS_LOG_KIND = "plugin-task-metrics"

/** `data.kind` of an execution log entry written through `PluginTaskContext.log`. */
export const PLUGIN_TASK_HANDLER_LOG_KIND = "plugin-task-log"

// =============================================================================
// Task Context
// =============================================================================

export interface PluginTaskContext {
  taskId: string
  executionId: string
  pluginId: string
  taskName: string
  scheduledAt: Date
  startedAt: Date
  attemptNumber: number
  /** What started this run: `schedule`, `run-now`, `retry`, `event`, `catch-up`, ... */
  triggerSource?: string
  /**
   * The event that fired this run, for an `event`-trigger task (a host event
   * or `ctx.scheduler.emitEvent`). Absent for every other kind of run.
   */
  event?: {
    type: string
    source?: string
    data?: Record<string, unknown>
  }
  signal: AbortSignal
  reportProgress: (progress: number, message?: string) => void
  /**
   * Write a line to this execution's log, the one `getExecutions()` returns
   * and the scheduler panel shows for the run. Also mirrored to the host
   * logger. `data` must be JSON-serializable to survive persistence.
   */
  log: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    data?: Record<string, unknown>
  ) => void
}

// =============================================================================
// Execution configuration
// =============================================================================

/**
 * Retry policy. Delays grow as `delaySeconds * 2^attempt` (plus up to 25%
 * jitter), capped by `maxRetryDelaySeconds` (60 s when unset).
 */
export interface PluginTaskRetryConfig {
  /**
   * Retries after the first attempt, not total attempts: `maxAttempts: 2`
   * runs a failing task up to three times. Kept under this name for
   * compatibility with plugins that already set it.
   */
  maxAttempts: number
  delaySeconds: number
  /**
   * The scheduler has exactly two retry curves, so exactly two values are
   * accepted: `2` (the default, exponential) and `1` (a fixed `delaySeconds`
   * between attempts, implemented by capping the delay at `delaySeconds`).
   * Any other value is rejected with an error rather than silently ignored.
   * Reported back as `1` when the cap equals the base delay, `2` otherwise.
   */
  backoffMultiplier?: number
}

/**
 * The scheduler's execution knobs a plugin task can set. Every field is
 * optional; an omitted field keeps the scheduler's default on create and the
 * stored value on update. Times are in seconds at this boundary.
 */
export interface PluginTaskExecutionOptions {
  /** What to do when a fire collides with a running execution. Default `skip`. */
  overlapPolicy?: PluginTaskOverlapPolicy
  /** Max buffered starts under `queue-all` (at least 1). Default 10. */
  maxQueueSize?: number
  /** Expire the task (`completed`) after this many runs, failures included. */
  maxRuns?: number
  /** Pause the task after this many consecutive terminal failures. */
  pauseAfterConsecutiveFailures?: number
  /** Random delay of up to this many seconds added to each cron / interval fire. */
  jitterSeconds?: number
  /** Missed slots older than this are skipped instead of replayed. */
  catchupWindowSeconds?: number
  /** Replay slots missed while the app was closed. Default `false` for plugin tasks. */
  runMissedOnStartup?: boolean
  /** How many missed slots to replay at most. Default 0 for plugin tasks. */
  maxMissedRuns?: number
  /** Cap on the exponential retry delay. Default 60. */
  maxRetryDelaySeconds?: number
}

// =============================================================================
// Task Handler
// =============================================================================

export type PluginTaskHandler = (
  args: Record<string, unknown>,
  context: PluginTaskContext
) => Promise<PluginTaskResult>

// =============================================================================
// Scheduled Task Definition
// =============================================================================

export interface PluginScheduledTask extends PluginTaskExecutionOptions {
  id: string
  pluginId: string
  name: string
  description?: string
  trigger: PluginTaskTrigger
  handler: string
  handlerArgs?: Record<string, unknown>
  status: PluginTaskStatus
  lastRunAt?: Date
  nextRunAt?: Date
  runCount: number
  /** The most recent settled run's result; absent until one has settled. */
  lastResult?: PluginTaskResult
  metadata?: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
  retry?: PluginTaskRetryConfig
  timeout?: number
  tags?: string[]
  /** Auto-expire the task once this instant passes. */
  endAt?: Date
  /** Consecutive terminal failures since the last success. */
  consecutiveFailures: number
  /** Last failure's message; cleared by the next success. */
  lastError?: string
  /** Why the task last stopped or settled (`max-runs-reached`, `auto-paused`, ...). */
  lastTerminalReason?: string
}

export interface PluginTaskExecution {
  id: string
  taskId: string
  pluginId: string
  status: PluginTaskExecutionStatus
  /** The slot this run was due at; the start time when it was not slot-bound. */
  scheduledAt: Date
  /** What started the run: `schedule`, `run-now`, `retry`, `event`, `catch-up`, ... */
  triggerSource?: string
  /** Structured outcome (`completed`, `retry-scheduled`, `user-cancelled`, ...). */
  terminalReason?: string
  startedAt?: Date
  completedAt?: Date
  duration?: number
  result?: PluginTaskResult
  attemptNumber: number
  error?: {
    message: string
    stack?: string
  }
  logs?: Array<{
    timestamp: Date
    level: "debug" | "info" | "warn" | "error"
    message: string
    data?: Record<string, unknown>
  }>
}

// =============================================================================
// Input Types
// =============================================================================

export interface CreatePluginTaskInput extends PluginTaskExecutionOptions {
  name: string
  description?: string
  trigger: PluginTaskTrigger
  handler: string
  handlerArgs?: Record<string, unknown>
  enabled?: boolean
  retry?: PluginTaskRetryConfig
  timeout?: number
  tags?: string[]
  metadata?: Record<string, unknown>
  /** Auto-expire the task once this instant passes. */
  endAt?: Date | string
}

export interface UpdatePluginTaskInput extends PluginTaskExecutionOptions {
  name?: string
  description?: string
  trigger?: PluginTaskTrigger
  handler?: string
  handlerArgs?: Record<string, unknown>
  retry?: PluginTaskRetryConfig
  timeout?: number
  tags?: string[]
  metadata?: Record<string, unknown>
  /** A new bound, or `null` to clear it. Omitted leaves it unchanged. */
  endAt?: Date | string | null
}

export interface PluginTaskFilter {
  /** Matched against the DERIVED status, so every member is honoured. */
  status?: PluginTaskStatus | PluginTaskStatus[]
  handler?: string
  tags?: string[]
  name?: string
  /**
   * `true`: tasks whose last terminal run failed and has not been followed by
   * a success (`consecutiveFailures > 0` or a `lastError`), whatever their
   * status, so an auto-paused task is included. `false`: the rest.
   */
  hasErrors?: boolean
  limit?: number
  offset?: number
}

// =============================================================================
// Execution events & statistics
// =============================================================================

/**
 * The moment an execution row reached:
 * `started` (running), `completed`, `failed` (including a `timeout` and an
 * attempt that will be retried, whose `terminalReason` is `retry-scheduled`),
 * `cancelled`, or `skipped` (a start that ended without running).
 */
export type PluginTaskExecutionPhase = "started" | "completed" | "failed" | "cancelled" | "skipped"

export interface PluginTaskExecutionEvent {
  phase: PluginTaskExecutionPhase
  taskId: string
  taskName: string
  handler: string
  execution: PluginTaskExecution
}

export interface PluginTaskStatistics {
  /** Every run, failures and cancellations included. */
  runCount: number
  successCount: number
  failureCount: number
  /** `successCount / (successCount + failureCount)`; null before anything settled. */
  successRate: number | null
  /** Mean duration of the most recent 100 settled runs; null when none has one. */
  averageDurationMs: number | null
  consecutiveFailures: number
  lastRunAt: Date | null
  nextRunAt: Date | null
  lastError: string | null
}

// =============================================================================
// Scheduler API
// =============================================================================

export interface PluginSchedulerAPI {
  // Task Management
  createTask: (input: CreatePluginTaskInput) => Promise<PluginScheduledTask>
  updateTask: (taskId: string, input: UpdatePluginTaskInput) => Promise<PluginScheduledTask | null>
  deleteTask: (taskId: string) => Promise<boolean>
  getTask: (taskId: string) => Promise<PluginScheduledTask | null>
  listTasks: (filter?: PluginTaskFilter) => Promise<PluginScheduledTask[]>

  // Task Control
  pauseTask: (taskId: string) => Promise<boolean>
  resumeTask: (taskId: string) => Promise<boolean>
  /**
   * Run an owned task now. `args` are merged over the task's `handlerArgs`
   * for this run only. Resolves with the id of the real execution row as soon
   * as the scheduler has decided what the start is (running, buffered by the
   * overlap policy, or skipped), not when the handler finishes.
   */
  runTaskNow: (taskId: string, args?: Record<string, unknown>) => Promise<string>
  /**
   * Stop a running (or buffered) execution of an owned task through the
   * scheduler's own cancel path. `true` when it was cancelled, or when the
   * request was handed to the context that runs it.
   */
  cancelExecution: (executionId: string) => Promise<boolean>
  /**
   * Fire this plugin's own active `event`-trigger tasks whose `eventType`
   * matches. The handler receives `payload` as `context.event.data`. The
   * event source is `plugin:<pluginId>`, so a task that names another
   * `eventSource` does not fire. The scheduler's usual rules apply: a task
   * past its `endAt` or `maxRuns` expires instead of firing, and its overlap
   * policy governs a collision. Never fires the user's or another plugin's
   * tasks. Resolves with how many tasks were started.
   */
  emitEvent: (eventType: string, payload?: Record<string, unknown>) => Promise<number>

  // Execution History
  getExecutions: (taskId: string, limit?: number) => Promise<PluginTaskExecution[]>
  getExecution: (executionId: string) => Promise<PluginTaskExecution | null>
  getLatestExecution: (taskId: string) => Promise<PluginTaskExecution | null>
  /** Counters and recent-duration average for an owned task; null when not owned. */
  getStatistics: (taskId: string) => Promise<PluginTaskStatistics | null>
  /**
   * Observe executions of THIS plugin's tasks. Returns a disposer; every
   * listener is also removed when the plugin deactivates.
   */
  onExecution: (listener: (event: PluginTaskExecutionEvent) => void) => () => void

  // Trigger tools
  /**
   * The next `count` (default 5, at most 100) instants `trigger` would fire
   * at, from now, through the same projection the scheduler panel uses. An
   * `event` trigger has no schedule and yields `[]`. A malformed trigger or an
   * invalid cron expression rejects with the validator's message.
   */
  previewTrigger: (trigger: PluginTaskTrigger, count?: number) => Promise<Date[]>

  // Handler Registration
  registerHandler: (name: string, handler: PluginTaskHandler) => () => void
  unregisterHandler: (name: string) => void
  hasHandler: (name: string) => boolean
  getHandlers: () => string[]
}
