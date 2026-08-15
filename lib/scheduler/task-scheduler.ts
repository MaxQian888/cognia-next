/**
 * Task Scheduler Service
 * Core service for managing scheduled tasks execution
 */

import { nanoid } from "nanoid"
import { computeBackoffDelay } from "@cognia/primitives"
import {
  type ScheduledTask,
  type TaskExecution,
  type TaskExecutionLog,
  type TaskExecutionConfig,
  type TaskTrigger,
  type CreateScheduledTaskInput,
  type UpdateScheduledTaskInput,
  type ScheduledTaskStatus,
  type TaskExecutionTriggerSource,
  type TaskExecutorResult,
  DEFAULT_EXECUTION_CONFIG,
  DEFAULT_NOTIFICATION_CONFIG,
} from "@/types/scheduler"
import { DEPRECATED_TASK_TYPES, isDeprecatedTaskType } from "./host-support"
import { getNextCronTime } from "./cron-parser"
import { enumerateBackfillSlots } from "./backfill"
import { schedulerDb } from "./scheduler-db"
import {
  applyJitter,
  isAtMaxRuns,
  isPastEndAt,
  isSlotOutsideCatchupWindow,
  resolveOverlapPolicy,
} from "./runtime-policy"
import { notifyTaskEvent } from "./notification-integration"
import { emitSchedulerEvent } from "./event-integration"
import { SchedulerError } from "./errors"
import { RendererTimingDriver } from "./timing/renderer-driver"
import { RustDaemonTimingDriver } from "./timing/rust-daemon-driver"
import { NodeTimingDriver } from "./timing/node-driver"
import { detectPlatform } from "@/lib/platform/detect"
import type { LeaderAwareTimingDriver, SchedulerTimingDriver } from "@/types/scheduler"
import { loggers } from "@cognia/logging"
import { getPluginLifecycleHooks } from "@/lib/plugin/messaging/hooks-system"
import { normalizeTaskTrigger } from "./trigger-normalizer"
import { normalizeConversationalTaskPayload } from "./conversational-task-authoring"
import { resolveCatchupDefaults } from "./catchup-policy"

// Logger
const log = loggers.scheduler

// Task executor registry
export type TaskExecutor = (
  task: ScheduledTask,
  execution: TaskExecution,
  signal: AbortSignal
) => Promise<TaskExecutorResult>

const executors: Map<string, TaskExecutor> = new Map()

/**
 * Listeners resolved when a specific task type gains an executor. Used by the
 * boot registration grace: subsystems register their executors from their
 * own boot chunk (connectors → `integrations`, scheduler → `workflow-automation`),
 * so a persisted `connection:*` task can come due before its executor exists.
 * Instead of failing immediately the scheduler waits (bounded) for this event.
 */
const executorRegistrationListeners: Map<string, Set<() => void>> = new Map()

/**
 * How long after scheduler start a due task may wait for its executor to be
 * registered before failing with `EXECUTOR_NOT_FOUND`. Sized for the slowest
 * deferred boot chunk on a cold desktop start; after the window the failure
 * is real (an unregistered custom/plugin handler) and must surface.
 */
export const EXECUTOR_REGISTRATION_GRACE_MS = 60_000

/**
 * Register a task executor for a specific task type
 */
export function registerTaskExecutor(taskType: string, executor: TaskExecutor): void {
  executors.set(taskType, executor)
  log.info(`Registered executor for task type: ${taskType}`)
  const waiters = executorRegistrationListeners.get(taskType)
  if (waiters) {
    executorRegistrationListeners.delete(taskType)
    for (const resolve of waiters) resolve()
  }
}

/**
 * Unregister a task executor
 */
export function unregisterTaskExecutor(taskType: string): void {
  executors.delete(taskType)
  log.info(`Unregistered executor for task type: ${taskType}`)
}

/**
 * Check whether a task executor is currently registered for a task type.
 */
export function hasTaskExecutor(taskType: string): boolean {
  return executors.has(taskType)
}

/**
 * Resolve when an executor for `taskType` is registered, or after `timeoutMs`
 * (whichever first). Aborting `signal` also resolves early. Returns whether an
 * executor is present afterwards.
 */
export function waitForTaskExecutor(
  taskType: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<boolean> {
  if (executors.has(taskType)) return Promise.resolve(true)
  if (timeoutMs <= 0 || signal?.aborted) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", settle)
      const waiters = executorRegistrationListeners.get(taskType)
      waiters?.delete(settle)
      if (waiters && waiters.size === 0) executorRegistrationListeners.delete(taskType)
      resolve(executors.has(taskType))
    }
    const timer = setTimeout(settle, timeoutMs)
    let waiters = executorRegistrationListeners.get(taskType)
    if (!waiters) {
      waiters = new Set()
      executorRegistrationListeners.set(taskType, waiters)
    }
    waiters.add(settle)
    signal?.addEventListener("abort", settle, { once: true })
  })
}

/**
 * Pick the timing driver for the local host:
 *
 *   - `tauri`    → Rust alarm daemon (fires while minimized to the tray);
 *   - `headless` → Node timers — the brain is one always-on process, the sole
 *                  authority for its own SchedulerDB (no tab-lock, no drift poll);
 *   - `web` / `mobile` → renderer timers + multi-tab leader election.
 *
 * Exported so tests pin the mapping; `createTaskScheduler(driver)` bypasses it.
 */
export function resolveDefaultTimingDriver(): SchedulerTimingDriver {
  switch (detectPlatform()) {
    case "tauri":
      return new RustDaemonTimingDriver()
    case "headless":
      return new NodeTimingDriver()
    default:
      return new RendererTimingDriver()
  }
}

/**
 * Task Scheduler class
 */
const EXECUTION_CHANNEL_NAME = "cognia-scheduler-executions"

export type ExecutionStatusEvent = {
  type: "execution-update"
  taskId: string
  executionId: string
  status: TaskExecution["status"]
  taskName: string
  duration?: number
  error?: string
}

interface ExecuteTaskContext {
  triggerSource?: TaskExecutionTriggerSource
  scheduledFor?: Date
  deferNextRunUpdate?: boolean
  scheduledSlotClaimed?: boolean
}

/** A buffered start waiting for the running execution to finish (queue-one / queue-all). */
interface QueuedStart {
  triggerSource: TaskExecutionTriggerSource
  scheduledFor?: Date
  deferNextRunUpdate?: boolean
  scheduledSlotClaimed?: boolean
}

class TaskSchedulerImpl {
  /** Ids currently armed in the timing driver (mirrors driver state for getStatus). */
  private armedTaskIds: Set<string> = new Set()
  /** Canonical (un-jittered) armed slot per task — `scheduledFor` always uses this. */
  private armedCanonicalMs: Map<string, number> = new Map()
  /** Running executions per task (executionId → execution); >1 entry under "allow". */
  private runningByTask: Map<string, Map<string, TaskExecution>> = new Map()
  /** Abort controllers per running execution (cancel-previous + timeout share them). */
  private executionControllers: Map<string, AbortController> = new Map()
  /** Buffered starts per task for the queue-one / queue-all overlap policies. */
  private queues: Map<string, QueuedStart[]> = new Map()
  private retryChains: Set<string> = new Set()
  /** Retry timers must not outlive pause/delete/stop lifecycle transitions. */
  private retryTimers: Map<string, Set<ReturnType<typeof setTimeout>>> = new Map()
  /** Invalidates async work from an older pause/delete lifecycle for one task. */
  private taskLifecycleVersions: Map<string, number> = new Map()
  private isInitialized = false
  /** Shared by concurrent early callers so the timing driver starts once. */
  private initializationPromise: Promise<void> | null = null
  /** Invalidates async initialization work when stop() begins a new lifecycle. */
  private lifecycleVersion = 0
  /** Becomes true immediately after driver.start(), before boot tasks are armed. */
  private driverReady = false
  /** Epoch-ms when the driver started; anchors the executor-registration grace. */
  private startedAtMs = 0
  /** Guards the one-shot deprecated-type sweep per process (see `pauseDeprecatedTasks`). */
  private deprecatedTasksSwept = false
  /** Guards the one-shot boot reconcile so multiple authority transitions in a
   * single process don't re-cancel executions repeatedly. */
  private staleExecutionsReconciled = false
  private checkInterval: ReturnType<typeof setInterval> | null = null
  private cleanupInterval: ReturnType<typeof setInterval> | null = null
  private leaderUnsubscribe: (() => void) | null = null
  private visibilityHandler: (() => void) | null = null
  private executionChannel: BroadcastChannel | null = null
  /**
   * Pluggable timing source. Resolved on `initialize()` by host platform —
   * Rust alarm daemon (Tauri desktop), Node timers (headless brain), renderer
   * timers + tab-lock (web / mobile) — unless a driver was injected via
   * `createTaskScheduler(driver)` for tests. See `resolveDefaultTimingDriver`.
   */
  private driver: SchedulerTimingDriver | null
  /** Injectable randomness source for deterministic jitter in tests. */
  private rng: () => number

  constructor(driver?: SchedulerTimingDriver, opts: { rng?: () => number } = {}) {
    this.driver = driver ?? null
    this.rng = opts.rng ?? Math.random
  }

  /** Whether any execution of this task is currently running. */
  private isTaskRunning(taskId: string): boolean {
    return (this.runningByTask.get(taskId)?.size ?? 0) > 0
  }

  private trackRunning(execution: TaskExecution): void {
    let perTask = this.runningByTask.get(execution.taskId)
    if (!perTask) {
      perTask = new Map()
      this.runningByTask.set(execution.taskId, perTask)
    }
    perTask.set(execution.id, execution)
  }

  private untrackRunning(execution: TaskExecution): void {
    const perTask = this.runningByTask.get(execution.taskId)
    if (!perTask) return
    perTask.delete(execution.id)
    if (perTask.size === 0) this.runningByTask.delete(execution.taskId)
  }

  /** True when this instance is the timing authority allowed to arm tasks. */
  private isTimingAuthority(): boolean {
    const driver = this.driver
    if (!driver || !driver.supportsLeaderElection) return true
    return (driver as LeaderAwareTimingDriver).isLeader()
  }

  /**
   * Initialize the scheduler
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return
    if (this.initializationPromise) return this.initializationPromise

    const version = this.lifecycleVersion
    const initializationPromise = this.initializeOnce(version)
    this.initializationPromise = initializationPromise
    try {
      await initializationPromise
    } finally {
      if (this.initializationPromise === initializationPromise) {
        this.initializationPromise = null
      }
    }
  }

  private async initializeOnce(version: number): Promise<void> {
    log.info("Initializing task scheduler...")

    try {
      // Resolve the timing driver for this host (see resolveDefaultTimingDriver).
      if (!this.driver) {
        this.driver = resolveDefaultTimingDriver()
      }
      const driver = this.driver

      // A task becomes due → execute it through the normal pipeline.
      driver.onDue((taskId, firedAtMs) => {
        void this.handleTaskDue(taskId, firedAtMs, version)
      })
      await driver.start()
      if (version !== this.lifecycleVersion) {
        driver.stop()
        return
      }
      this.driverReady = true
      this.startedAtMs = Date.now()

      if (driver.supportsLeaderElection) {
        // Renderer: only the leader tab arms/executes. Subscribe to leadership
        // changes to (re)arm or disarm all tasks.
        const leaderAware = driver as LeaderAwareTimingDriver
        this.leaderUnsubscribe = leaderAware.onLeaderChange((isLeader) => {
          if (version !== this.lifecycleVersion) return
          if (isLeader) {
            log.info("This tab became leader — scheduling all active tasks")
            this.scheduleAllActiveTasks(version).catch((err) => {
              log.error("Error scheduling tasks after becoming leader:", err)
            })
          } else {
            log.info("This tab lost leadership — unscheduling all tasks")
            this.unscheduleAllTasks()
          }
        })
        if (leaderAware.isLeader()) {
          await this.scheduleAllActiveTasks(version)
        }
      } else {
        // Rust daemon: single native process is the sole authority.
        await this.scheduleAllActiveTasks(version)
      }
      if (version !== this.lifecycleVersion) {
        driver.stop()
        return
      }

      // Start periodic check for missed tasks (belt-and-suspenders in both
      // modes — the executeTask concurrency guard prevents double-fire).
      this.startPeriodicCheck()

      // Start auto-cleanup for old executions (runs every 24 hours)
      this.startAutoCleanup()

      // Initialize BroadcastChannel for real-time execution status updates
      try {
        this.executionChannel = new BroadcastChannel(EXECUTION_CHANNEL_NAME)
      } catch {
        log.warn("BroadcastChannel not available for execution status updates")
      }

      // Visibility-aware catch-up only matters when renderer timers can be
      // throttled on a hidden tab; the Rust daemon fires regardless.
      if (driver.supportsLeaderElection && typeof document !== "undefined") {
        const leaderAware = driver as LeaderAwareTimingDriver
        this.visibilityHandler = () => {
          if (!document.hidden && leaderAware.isLeader()) {
            log.debug("Tab became visible — checking for missed tasks")
            this.checkMissedTasks().catch((err) => {
              log.error("Error checking missed tasks on visibility change:", err)
            })
          }
        }
        document.addEventListener("visibilitychange", this.visibilityHandler)
      }

      this.isInitialized = true
      log.info("Task scheduler initialized successfully")
    } catch (error) {
      if (version !== this.lifecycleVersion) {
        this.driver?.stop()
        return
      }
      this.driverReady = false
      this.driver?.stop()
      log.error("Failed to initialize task scheduler:", error)
      throw SchedulerError.initFailed(
        error instanceof Error ? error.message : String(error),
        error instanceof Error ? error : undefined
      )
    }
  }

  /**
   * Schedule all active tasks (called on init and when becoming leader)
   */
  private async scheduleAllActiveTasks(version: number = this.lifecycleVersion): Promise<void> {
    if (version !== this.lifecycleVersion) return
    // Boot reconcile (once per process, at the first authority transition):
    // cancel executions left `running`/`pending` by a previous process. Their
    // in-memory controllers didn't survive the reload/crash, so the Dexie rows
    // would otherwise show "running" forever. Only the timing authority reaches
    // this method (daemon, or the leader tab), so a non-leader tab can never
    // cancel the live leader's in-flight executions.
    if (!this.staleExecutionsReconciled) {
      this.staleExecutionsReconciled = true
      try {
        const reconciled = await schedulerDb.interruptStaleExecutions()
        if (reconciled > 0) {
          log.info(`Reconciled ${reconciled} stale scheduler execution(s) on boot`)
        }
      } catch (err) {
        log.error("Failed to reconcile stale executions on boot:", err)
      }
    }

    // Deprecated task types (`sync`, `ai-generation`) have no executor: park
    // them instead of letting them fire into EXECUTOR_NOT_FOUND every slot.
    if (!this.deprecatedTasksSwept) {
      this.deprecatedTasksSwept = true
      try {
        const paused = await this.pauseDeprecatedTasks()
        if (paused > 0) log.warn(`Paused ${paused} scheduled task(s) with a deprecated type`)
      } catch (err) {
        log.error("Failed to sweep deprecated-type tasks on boot:", err)
      }
      if (version !== this.lifecycleVersion) return
    }

    const tasks = await schedulerDb.getTasksByStatus("active")
    if (version !== this.lifecycleVersion) return
    log.info(`Found ${tasks.length} active tasks to schedule`)
    for (const task of tasks) {
      if (version !== this.lifecycleVersion) return
      await this.scheduleTask(task, version)
    }
  }

  /**
   * Pause every still-active task whose type is in `DEPRECATED_TASK_TYPES`
   * and record one `deprecated-type` execution row per task so the detail
   * view can explain what happened. Idempotent: paused rows are left alone.
   * Returns the number of tasks paused.
   */
  private async pauseDeprecatedTasks(): Promise<number> {
    let paused = 0
    for (const type of DEPRECATED_TASK_TYPES) {
      const rows = await schedulerDb.getTasksByType(type)
      for (const task of rows) {
        if (task.status !== "active") continue
        const now = new Date()
        await schedulerDb.updateTask({
          ...task,
          status: "paused",
          nextRunAt: undefined,
          lastTerminalReason: "deprecated-type",
          lastTerminalAt: now,
          updatedAt: now,
        })
        this.unscheduleTask(task.id)
        await this.createSkippedExecution(task, {
          triggerSource: "schedule",
          terminalReason: "deprecated-type",
          message: `Task type "${task.type}" is deprecated and has no executor; the task was paused. Recreate it as a "chat" task or delete it.`,
        })
        paused += 1
      }
    }
    return paused
  }

  /**
   * Unschedule all tasks (called when losing leadership)
   */
  private unscheduleAllTasks(): void {
    for (const taskId of Array.from(this.armedTaskIds)) {
      this.unscheduleTask(taskId)
    }
  }

  /**
   * Handle a task becoming due (fired by the timing driver). Resolves the
   * latest task row and runs it through the same execution path as before.
   * `firedAtMs` is the originally-armed slot so interval cadence stays stable.
   */
  private async handleTaskDue(taskId: string, firedAtMs: number, version: number): Promise<void> {
    if (version !== this.lifecycleVersion) return
    this.armedTaskIds.delete(taskId)
    // Jitter only shifts the armed epoch; the canonical slot identity is
    // preserved here so interval cadence and missed-run math stay stable.
    const canonicalMs = this.armedCanonicalMs.get(taskId) ?? firedAtMs
    this.armedCanonicalMs.delete(taskId)
    const task = await schedulerDb.getTask(taskId)
    if (version !== this.lifecycleVersion) return
    if (!task || task.status !== "active") return
    const now = new Date()
    // Lifecycle bounds are checked before consuming the persisted slot so an
    // expired task records its terminal state without advancing the schedule.
    if (isPastEndAt(task, now) || isAtMaxRuns(task)) {
      await this.expireTask(task, isAtMaxRuns(task) ? "max-runs-reached" : "ended")
      return
    }
    const scheduledFor = new Date(canonicalMs)
    const nextRunAt = this.getNextRunAfter(task.trigger, scheduledFor)
    // Backlog head: the slot *after* this one has already elapsed too, so the
    // process was away (app closed, machine asleep, tab throttled) for more
    // than one period. Claiming this slot would persist an already-past
    // `nextRunAt`, which the driver re-arms with a zero delay — replaying the
    // entire backlog in a tight loop, one execution record and one overlap
    // warning per missed slot. Hand the whole window to the missed-run policy
    // instead: it honors runMissedOnStartup / maxMissedRuns / catchupWindowMs
    // and lands on the first *future* slot in a single step.
    if (
      (task.trigger.type === "interval" || task.trigger.type === "cron") &&
      nextRunAt &&
      nextRunAt <= now
    ) {
      await this.reconcileMissedRecurringTask(task, now, version)
      return
    }
    const claimedTask = await schedulerDb.claimTaskSlot(taskId, scheduledFor, nextRunAt)
    if (version !== this.lifecycleVersion) return
    if (!claimedTask) return
    if (claimedTask.nextRunAt) {
      await this.scheduleTask(claimedTask, version)
    }
    if (version !== this.lifecycleVersion) return
    this.executeTask(claimedTask, 0, {
      triggerSource: "schedule",
      scheduledFor,
      scheduledSlotClaimed: true,
    }).catch((err) => {
      log.error(`Error executing scheduled task ${claimedTask.name}:`, err)
    })
  }

  /**
   * Start periodic check for tasks that might have been missed
   */
  private startPeriodicCheck(): void {
    // Check every minute for any missed tasks
    this.checkInterval = setInterval(() => {
      this.checkMissedTasks().catch((err) => {
        log.error("Error checking missed tasks:", err)
      })
    }, 60000)
  }

  /**
   * Start auto-cleanup for old execution records
   * Runs every 24 hours to clean up executions older than 30 days
   */
  private startAutoCleanup(): void {
    const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000 // 24 hours
    const MAX_AGE_DAYS = 30

    // Run initial cleanup
    this.cleanupOldExecutions(MAX_AGE_DAYS).catch((err) => {
      log.error("Error in initial cleanup:", err)
    })

    // Schedule periodic cleanup
    this.cleanupInterval = setInterval(() => {
      this.cleanupOldExecutions(MAX_AGE_DAYS).catch((err) => {
        log.error("Error in auto-cleanup:", err)
      })
    }, CLEANUP_INTERVAL)
  }

  /**
   * Clean up old execution records
   */
  private async cleanupOldExecutions(maxAgeDays: number): Promise<void> {
    try {
      const deleted = await schedulerDb.cleanupOldExecutions(maxAgeDays)
      if (deleted > 0) {
        log.info(`Auto-cleanup: Removed ${deleted} old execution records`)
      }
    } catch (error) {
      log.error("Failed to cleanup old executions:", error)
    }
  }

  /**
   * Check and run any missed tasks
   */
  private async checkMissedTasks(): Promise<void> {
    const now = new Date()
    const tasks = await schedulerDb.getOverdueActiveTasks(now)

    for (const task of tasks) {
      if (!task.nextRunAt) {
        continue
      }

      if (task.trigger.type === "once") {
        await this.expireMissedOneTimeTask(task, now)
        continue
      }

      if (task.trigger.type !== "cron" && task.trigger.type !== "interval") {
        await this.updateNextRunTime(task, { fromDate: now })
        continue
      }

      await this.reconcileMissedRecurringTask(task, now)
    }
  }

  /**
   * Collect due run slots up to task maxMissedRuns and compute first future slot.
   */
  private collectMissedRunSlots(
    task: ScheduledTask,
    now: Date
  ): { dueSlots: Date[]; nextFutureSlot?: Date } {
    const dueSlots: Date[] = []
    const maxMissedRuns = Math.max(0, task.config.maxMissedRuns ?? 1)
    let cursor = task.nextRunAt

    if (!cursor) {
      return {
        dueSlots,
        nextFutureSlot: this.calculateNextRunTime(task, { fromDate: now }),
      }
    }

    while (cursor && cursor <= now && dueSlots.length < maxMissedRuns) {
      dueSlots.push(cursor)
      cursor = this.getNextRunAfter(task.trigger, cursor)
    }

    // Always advance to a future slot so overdue windows are reconciled
    // deterministically. Intervals jump in O(1): this is the only path that
    // walks a long backlog now, and stepping period-by-period over a short
    // interval times days of downtime would burn millions of iterations.
    if (cursor && cursor <= now && task.trigger.type === "interval" && task.trigger.intervalMs) {
      const intervalMs = task.trigger.intervalMs
      const steps = Math.ceil((now.getTime() - cursor.getTime() + 1) / intervalMs)
      cursor = new Date(cursor.getTime() + steps * intervalMs)
    }
    while (cursor && cursor <= now) {
      cursor = this.getNextRunAfter(task.trigger, cursor)
    }

    return { dueSlots, nextFutureSlot: cursor }
  }

  private async persistNextFutureSlot(
    task: ScheduledTask,
    nextFutureSlot?: Date,
    terminalReason?: string,
    expectedVersion?: number
  ): Promise<void> {
    const now = new Date()
    if (nextFutureSlot) {
      const updatedTask: ScheduledTask = {
        ...task,
        nextRunAt: nextFutureSlot,
        updatedAt: now,
        ...(terminalReason
          ? {
              lastTerminalReason: terminalReason,
              lastTerminalAt: now,
            }
          : {}),
      }
      await schedulerDb.updateTask(updatedTask)
      await this.scheduleTask(updatedTask, expectedVersion)
      return
    }

    await schedulerDb.updateTask({
      ...task,
      nextRunAt: undefined,
      updatedAt: now,
      ...(terminalReason
        ? {
            lastTerminalReason: terminalReason,
            lastTerminalAt: now,
          }
        : {}),
    })
  }

  private async reconcileMissedRecurringTask(
    task: ScheduledTask,
    now: Date,
    expectedVersion?: number
  ): Promise<void> {
    const { dueSlots: rawDueSlots, nextFutureSlot } = this.collectMissedRunSlots(task, now)

    // Time-based catch-up window: slots older than catchupWindowMs are skipped
    // with their own terminal reason instead of being re-run (Temporal
    // CatchupWindow semantics). Applied after the count cap.
    let dueSlots = rawDueSlots
    const windowMs = task.config.catchupWindowMs
    if (typeof windowMs === "number" && windowMs > 0 && rawDueSlots.length > 0) {
      const expired = rawDueSlots.filter((slot) => isSlotOutsideCatchupWindow(slot, now, windowMs))
      dueSlots = rawDueSlots.filter((slot) => !isSlotOutsideCatchupWindow(slot, now, windowMs))
      for (const slot of expired) {
        await this.createSkippedExecution(task, {
          triggerSource: "catch-up",
          scheduledFor: slot,
          terminalReason: "catchup-window-expired",
          message: `Skipped: missed slot older than the catch-up window (${windowMs}ms)`,
        })
      }
      if (dueSlots.length === 0 && expired.length > 0) {
        await this.persistNextFutureSlot(
          task,
          nextFutureSlot,
          "catchup-window-expired",
          expectedVersion
        )
        return
      }
    }

    if (dueSlots.length === 0) {
      if (task.nextRunAt && task.nextRunAt <= now) {
        await this.createSkippedExecution(task, {
          triggerSource: "catch-up",
          scheduledFor: task.nextRunAt,
          terminalReason: "missed-run-skipped",
          message: "Skipped missed run reconciliation by policy",
        })
        await this.persistNextFutureSlot(
          task,
          nextFutureSlot,
          "missed-run-skipped",
          expectedVersion
        )
        return
      }
      await this.persistNextFutureSlot(task, nextFutureSlot, undefined, expectedVersion)
      return
    }

    if (!task.config.runMissedOnStartup) {
      await this.createSkippedExecution(task, {
        triggerSource: "catch-up",
        scheduledFor: dueSlots[0],
        terminalReason: "missed-run-skipped",
        message: "Skipped missed run reconciliation by policy",
      })
      await this.persistNextFutureSlot(task, nextFutureSlot, "missed-run-skipped", expectedVersion)
      return
    }

    for (const slot of dueSlots) {
      await this.executeTask(task, 0, {
        triggerSource: "catch-up",
        scheduledFor: slot,
        deferNextRunUpdate: true,
      })
    }

    await this.persistNextFutureSlot(task, nextFutureSlot, undefined, expectedVersion)
  }

  private async expireMissedOneTimeTask(task: ScheduledTask, now: Date): Promise<void> {
    await this.createSkippedExecution(task, {
      triggerSource: "catch-up",
      scheduledFor: task.nextRunAt,
      terminalReason: "once-expired",
      message: "One-time task expired before execution",
    })

    await schedulerDb.updateTask({
      ...task,
      status: "expired",
      nextRunAt: undefined,
      lastTerminalReason: "once-expired",
      lastTerminalAt: now,
      updatedAt: now,
    })

    this.unscheduleTask(task.id)
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    log.info("Stopping task scheduler...")
    this.lifecycleVersion += 1
    this.initializationPromise = null

    for (const controller of this.executionControllers.values()) {
      controller.abort("scheduler-stopped")
    }
    for (const timers of this.retryTimers.values()) {
      for (const timer of timers) clearTimeout(timer)
    }
    this.retryTimers.clear()
    this.retryChains.clear()
    this.queues.clear()

    // Unsubscribe leader-change listener (renderer driver only)
    if (this.leaderUnsubscribe) {
      this.leaderUnsubscribe()
      this.leaderUnsubscribe = null
    }

    // Remove visibility handler
    if (this.visibilityHandler && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityHandler)
      this.visibilityHandler = null
    }

    // Tear down the timing driver (clears its timers / leader election /
    // event listener) and forget armed ids.
    this.driver?.stop()
    this.armedTaskIds.clear()

    // Clear periodic check
    if (this.checkInterval) {
      clearInterval(this.checkInterval)
      this.checkInterval = null
    }

    // Clear auto-cleanup
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }

    // Close execution channel
    try {
      this.executionChannel?.close()
    } catch {
      /* ignore */
    }
    this.executionChannel = null

    this.isInitialized = false
    this.driverReady = false
    // A stop → start cycle is a fresh boot; reconcile orphaned executions again.
    this.staleExecutionsReconciled = false
    log.info("Task scheduler stopped")
  }

  /**
   * Broadcast execution status change via BroadcastChannel
   */
  private broadcastExecutionStatus(execution: TaskExecution): void {
    try {
      this.executionChannel?.postMessage({
        type: "execution-update",
        taskId: execution.taskId,
        executionId: execution.id,
        status: execution.status,
        taskName: execution.taskName,
        duration: execution.duration,
        error: execution.error,
      } satisfies ExecutionStatusEvent)
    } catch {
      /* channel closed or unavailable */
    }
  }

  /**
   * Create a new scheduled task
   */
  async createTask(input: CreateScheduledTaskInput): Promise<ScheduledTask> {
    if (isDeprecatedTaskType(input.type)) {
      throw SchedulerError.deprecatedTaskType(input.type)
    }
    const now = new Date()
    const normalizedTrigger = normalizeTaskTrigger(input.trigger, { now })

    // Catch-up defaults sit BETWEEN the global defaults and the caller's config,
    // so what a missed slot does follows from the task type unless the author
    // said otherwise. Only reached here: existing rows keep their stored config.
    const config: TaskExecutionConfig = {
      ...DEFAULT_EXECUTION_CONFIG,
      ...resolveCatchupDefaults(input.type),
      ...input.config,
    }

    const task: ScheduledTask = {
      id: nanoid(),
      name: input.name,
      description: input.description,
      type: input.type,
      trigger: normalizedTrigger,
      payload: normalizeConversationalTaskPayload(input.type, input.payload),
      config: {
        ...config,
        maxMissedRuns: Math.max(0, config.maxMissedRuns ?? 1),
      },
      notification: { ...DEFAULT_NOTIFICATION_CONFIG, ...input.notification },
      status: "active",
      createdBy: input.createdBy ?? { kind: "user" },
      tags: input.tags,
      endAt: input.endAt,
      onSuccessTaskIds: input.onSuccessTaskIds,
      onFailureTaskIds: input.onFailureTaskIds,
      runCount: 0,
      successCount: 0,
      failureCount: 0,
      createdAt: now,
      updatedAt: now,
    }

    // Calculate next run time
    task.nextRunAt = this.calculateNextRunTime(task, { fromDate: now })

    // Save to database
    await schedulerDb.createTask(task)
    log.info(`Created task: ${task.name} (${task.id})`)

    // Schedule if active
    if (task.status === "active") {
      await this.scheduleTask(task)
    }

    return task
  }

  /**
   * Update an existing task
   */
  async updateTask(taskId: string, input: UpdateScheduledTaskInput): Promise<ScheduledTask | null> {
    if (input.status !== undefined && input.status !== "active") {
      this.invalidateTaskLifecycle(taskId)
      this.unscheduleTask(taskId)
      this.clearTaskRetries(taskId)
      this.queues.delete(taskId)
    }
    const task = await schedulerDb.getTask(taskId)
    if (!task) {
      log.warn(`Task not found: ${taskId}`)
      return null
    }

    const now = new Date()
    const mergedTrigger: TaskTrigger = {
      ...task.trigger,
      ...(input.trigger ?? {}),
    }
    const normalizedTrigger = input.trigger
      ? normalizeTaskTrigger(mergedTrigger, { now })
      : task.trigger

    // Update fields
    const updatedTask: ScheduledTask = {
      ...task,
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      trigger: normalizedTrigger,
      ...(input.payload && {
        payload: normalizeConversationalTaskPayload(task.type, {
          ...(task.payload || {}),
          ...input.payload,
        }),
      }),
      ...(input.config && {
        config: {
          ...task.config,
          ...input.config,
          maxMissedRuns: Math.max(
            0,
            input.config.maxMissedRuns ??
              task.config.maxMissedRuns ??
              DEFAULT_EXECUTION_CONFIG.maxMissedRuns ??
              1
          ),
        },
      }),
      ...(input.notification && { notification: { ...task.notification, ...input.notification } }),
      ...(input.status !== undefined && { status: input.status }),
      ...(input.tags !== undefined && { tags: input.tags }),
      // endAt: null clears the bound, undefined leaves it untouched
      ...(input.endAt !== undefined && { endAt: input.endAt ?? undefined }),
      ...(input.onSuccessTaskIds !== undefined && { onSuccessTaskIds: input.onSuccessTaskIds }),
      ...(input.onFailureTaskIds !== undefined && { onFailureTaskIds: input.onFailureTaskIds }),
      updatedAt: now,
    }

    // Recalculate next run time if trigger changed
    if (input.trigger) {
      updatedTask.nextRunAt = this.calculateNextRunTime(updatedTask, { fromDate: now })
    }

    // Save to database
    await schedulerDb.updateTask(updatedTask)
    log.info(`Updated task: ${updatedTask.name} (${taskId})`)

    // Reschedule
    this.unscheduleTask(taskId)
    if (updatedTask.status !== "active") {
      this.clearTaskRetries(taskId)
      this.queues.delete(taskId)
    }
    if (updatedTask.status === "active") {
      await this.scheduleTask(updatedTask)
    }

    return updatedTask
  }

  /**
   * Delete a task
   */
  async deleteTask(taskId: string): Promise<boolean> {
    this.invalidateTaskLifecycle(taskId)
    this.unscheduleTask(taskId)
    this.clearTaskRetries(taskId)
    this.queues.delete(taskId)
    const running = this.runningByTask.get(taskId)
    for (const executionId of running ? Array.from(running.keys()) : []) {
      this.executionControllers.get(executionId)?.abort("task-deleted")
    }
    const deleted = await schedulerDb.deleteTask(taskId)
    if (deleted) {
      log.info(`Deleted task: ${taskId}`)
    }
    return deleted
  }

  /**
   * Get a task by ID
   */
  async getTask(taskId: string): Promise<ScheduledTask | null> {
    return schedulerDb.getTask(taskId)
  }

  /**
   * Get all tasks
   */
  async getAllTasks(): Promise<ScheduledTask[]> {
    return schedulerDb.getAllTasks()
  }

  /**
   * Pause a task
   */
  async pauseTask(taskId: string): Promise<boolean> {
    // Invalidate first: a running execution can settle while the database read
    // below is pending, and must not recreate a retry after pause has begun.
    this.invalidateTaskLifecycle(taskId)
    this.unscheduleTask(taskId)
    this.clearTaskRetries(taskId)
    this.queues.delete(taskId)
    const task = await schedulerDb.getTask(taskId)
    if (!task) return false

    await schedulerDb.updateTask({ ...task, status: "paused", updatedAt: new Date() })
    log.info(`Paused task: ${task.name} (${taskId})`)
    return true
  }

  /**
   * Resume a task
   */
  async resumeTask(taskId: string): Promise<boolean> {
    const task = await schedulerDb.getTask(taskId)
    if (!task || task.status !== "paused") return false
    if (isDeprecatedTaskType(task.type)) {
      throw SchedulerError.deprecatedTaskType(task.type)
    }

    const updatedTask = {
      ...task,
      status: "active" as ScheduledTaskStatus,
      nextRunAt: this.calculateNextRunTime(task, { fromDate: new Date() }),
      updatedAt: new Date(),
    }
    await schedulerDb.updateTask(updatedTask)
    await this.scheduleTask(updatedTask)
    log.info(`Resumed task: ${task.name} (${taskId})`)
    return true
  }

  /**
   * Run a task immediately
   */
  async runTaskNow(
    taskId: string,
    opts: { triggerSource?: TaskExecutionTriggerSource } = {}
  ): Promise<TaskExecution | null> {
    const task = await schedulerDb.getTask(taskId)
    if (!task) {
      log.warn(`Task not found for immediate run: ${taskId}`)
      return null
    }

    return this.executeTask(task, 0, { triggerSource: opts.triggerSource ?? "run-now" })
  }

  /**
   * Get task executions
   */
  async getTaskExecutions(taskId: string, limit: number = 50): Promise<TaskExecution[]> {
    return schedulerDb.getTaskExecutions(taskId, limit)
  }

  /**
   * Manually re-run the past schedule slots of a cron/interval task inside
   * [start, end] (Temporal backfill semantics). Slots execute sequentially,
   * oldest first, with `triggerSource: "backfill"` and the slot as
   * `scheduledFor`; the live `nextRunAt` cadence is never touched
   * (`deferNextRunUpdate`). Runs go through the task's normal overlap policy,
   * so a live fire mid-backfill is governed uniformly.
   */
  async backfillTask(taskId: string, range: { start: Date; end: Date }): Promise<TaskExecution[]> {
    const task = await schedulerDb.getTask(taskId)
    if (!task) {
      throw SchedulerError.taskNotFound(taskId)
    }
    if (task.trigger.type !== "cron" && task.trigger.type !== "interval") {
      throw SchedulerError.invalidTrigger("Backfill supports cron and interval triggers only", {
        triggerType: task.trigger.type,
      })
    }

    const slots = enumerateBackfillSlots(task, range.start, range.end)
    log.info(`Backfilling task ${task.name}: ${slots.length} slot(s) in range`)

    const executions: TaskExecution[] = []
    for (const slot of slots) {
      const execution = await this.executeTask(task, 0, {
        triggerSource: "backfill",
        scheduledFor: slot,
        deferNextRunUpdate: true,
      })
      executions.push(execution)
    }
    return executions
  }

  /**
   * Schedule a task for execution by arming the timing driver at its next-run
   * instant. The driver (renderer timers or the Rust alarm daemon) invokes
   * `handleTaskDue` when the instant elapses; overdue instants fire promptly.
   */
  private async scheduleTask(task: ScheduledTask, expectedVersion?: number): Promise<void> {
    if (expectedVersion !== undefined && expectedVersion !== this.lifecycleVersion) return
    if (task.status !== "active") return
    if (task.trigger.type === "event") return

    // Lazy lifecycle check: never arm a task that has crossed its bounds.
    if (isPastEndAt(task, new Date()) || isAtMaxRuns(task)) {
      await this.expireTask(task, isAtMaxRuns(task) ? "max-runs-reached" : "ended")
      return
    }

    const nextRun = task.nextRunAt || this.calculateNextRunTime(task)
    if (!nextRun) {
      log.warn(`Could not calculate next run time for task: ${task.name}`)
      return
    }

    let driver = this.driver
    if (!driver || !this.driverReady) {
      if (expectedVersion !== undefined && expectedVersion !== this.lifecycleVersion) return
      // Lifecycle writes can legitimately arrive before React/headless startup
      // mounts the scheduler initializer (notably plugin activation). Start it
      // here. The boot sweep normally arms the persisted task; if its read view
      // missed the concurrent write, continue below and arm it directly.
      await this.initialize()
      if (expectedVersion !== undefined && expectedVersion !== this.lifecycleVersion) return
      if (this.armedTaskIds.has(task.id)) return
      driver = this.driver
    }
    if (expectedVersion !== undefined && expectedVersion !== this.lifecycleVersion) return
    if (!driver || !this.driverReady || !this.isTimingAuthority()) return

    this.armedTaskIds.add(task.id)
    // Arm with optional jitter; remember the canonical slot for handleTaskDue.
    const canonicalMs = nextRun.getTime()
    this.armedCanonicalMs.set(task.id, canonicalMs)
    if (expectedVersion !== undefined && expectedVersion !== this.lifecycleVersion) {
      this.armedTaskIds.delete(task.id)
      this.armedCanonicalMs.delete(task.id)
      return
    }
    await driver.arm(task.id, applyJitter(canonicalMs, task.trigger.jitterMs, this.rng))

    log.debug(`Scheduled task ${task.name} for ${nextRun.toISOString()}`)
  }

  /**
   * Unschedule a task
   */
  private unscheduleTask(taskId: string): void {
    if (this.armedTaskIds.delete(taskId)) {
      log.debug(`Unscheduled task: ${taskId}`)
    }
    this.armedCanonicalMs.delete(taskId)
    void this.driver?.disarm(taskId)
  }

  /**
   * Expire a task that crossed a lifecycle bound (`endAt` passed or `maxRuns`
   * consumed). Mirrors `expireMissedOneTimeTask` minus the skipped-execution
   * record — nothing was due; the schedule simply ended.
   */
  private async expireTask(
    task: ScheduledTask,
    reason: "ended" | "max-runs-reached"
  ): Promise<void> {
    const now = new Date()
    await schedulerDb.updateTask({
      ...task,
      status: "expired",
      nextRunAt: undefined,
      lastTerminalReason: reason,
      lastTerminalAt: now,
      updatedAt: now,
    })
    this.unscheduleTask(task.id)
    this.queues.delete(task.id)
    log.info(`Task ${task.name} expired (${reason})`)
  }

  /**
   * Execute a task
   */
  private async executeTask(
    task: ScheduledTask,
    retryAttempt: number = 0,
    context: ExecuteTaskContext = {}
  ): Promise<TaskExecution> {
    const executionLifecycleVersion = this.lifecycleVersion
    const taskLifecycleVersion = this.getTaskLifecycleVersion(task.id)
    const executionId = nanoid()
    const startTime = new Date()
    const triggerSource = context.triggerSource ?? (retryAttempt > 0 ? "retry" : "schedule")
    const isRetryExecution = triggerSource === "retry"
    const retryChainActive = this.retryChains.has(task.id)

    // Overlap policy: decide what happens when this start collides with a
    // running execution (or an active retry chain, which is a continuation of
    // the same logical run).
    const overlapPolicy = resolveOverlapPolicy(task.config)
    const retryBlocked = retryChainActive && !isRetryExecution
    if (overlapPolicy !== "allow" && (this.isTaskRunning(task.id) || retryBlocked)) {
      switch (overlapPolicy) {
        case "queue-one":
        case "queue-all": {
          const queue = this.queues.get(task.id) ?? []
          const queuedStart: QueuedStart = {
            triggerSource,
            scheduledFor: context.scheduledFor,
            deferNextRunUpdate: context.deferNextRunUpdate,
            scheduledSlotClaimed: context.scheduledSlotClaimed,
          }
          if (overlapPolicy === "queue-one") {
            // Newest wins: any displaced pending start is dropped as skipped.
            for (const displaced of queue) {
              await this.createSkippedExecution(task, {
                triggerSource: displaced.triggerSource,
                scheduledFor: displaced.scheduledFor,
                terminalReason: "overlap-skipped",
                message: "Skipped: displaced by a newer buffered start (queue-one)",
              })
            }
            this.queues.set(task.id, [queuedStart])
            log.debug(`Task ${task.name} start buffered (queue-one)`)
            return this.createQueuedPlaceholderExecution(task, executionId, queuedStart)
          }
          const maxQueueSize = Math.max(
            1,
            task.config.maxQueueSize ?? DEFAULT_EXECUTION_CONFIG.maxQueueSize ?? 10
          )
          if (queue.length >= maxQueueSize) {
            log.warn(`Task ${task.name} start dropped: queue full (${maxQueueSize})`)
            return this.createSkippedExecution(task, {
              triggerSource,
              scheduledFor: context.scheduledFor,
              terminalReason: "overlap-skipped",
              message: `Skipped: start buffer full (queue-all, max ${maxQueueSize})`,
              retryAttempt,
            })
          }
          queue.push(queuedStart)
          this.queues.set(task.id, queue)
          log.debug(`Task ${task.name} start buffered (queue-all, ${queue.length} pending)`)
          return this.createQueuedPlaceholderExecution(task, executionId, queuedStart)
        }
        case "cancel-previous": {
          if (retryBlocked) {
            // A pending retry timer cannot be aborted safely — treat as skip.
            log.warn(`Task ${task.name} execution skipped due to retry-chain-active`)
            return this.createSkippedExecution(task, {
              triggerSource,
              scheduledFor: context.scheduledFor,
              terminalReason: "retry-chain-active",
              message: "Skipped: retry chain is still active for this task",
              retryAttempt,
            })
          }
          // Abort every running execution of this task, then proceed.
          const perTask = this.runningByTask.get(task.id)
          for (const runningId of perTask ? Array.from(perTask.keys()) : []) {
            this.executionControllers.get(runningId)?.abort("overlap-cancelled")
          }
          log.info(`Task ${task.name}: cancelled previous execution(s) (cancel-previous)`)
          break
        }
        case "skip":
        default: {
          const terminalReason = retryBlocked ? "retry-chain-active" : "overlap-skipped"
          log.warn(`Task ${task.name} execution skipped due to ${terminalReason}`)
          return this.createSkippedExecution(task, {
            triggerSource,
            scheduledFor: context.scheduledFor,
            terminalReason,
            message:
              terminalReason === "retry-chain-active"
                ? "Skipped: retry chain is still active for this task"
                : "Skipped: concurrent execution not allowed (overlap policy: skip)",
            retryAttempt,
          })
        }
      }
    }

    // Create execution record
    const execution: TaskExecution = {
      id: executionId,
      taskId: task.id,
      taskName: task.name,
      taskType: task.type,
      status: "running",
      input: task.payload,
      retryAttempt,
      scheduledFor: context.scheduledFor,
      triggerSource,
      startedAt: startTime,
      logs: [this.createLog("info", `Starting task execution (attempt ${retryAttempt + 1})`)],
    }

    let shouldRetry = false
    let nextRetryAt: Date | undefined

    const controller = new AbortController()
    this.executionControllers.set(executionId, controller)
    this.trackRunning(execution)
    await schedulerDb.createExecution(execution)
    this.broadcastExecutionStatus(execution)

    // Notify start
    if (task.notification.onStart) {
      await notifyTaskEvent(task, execution, "start")
    }

    // Dispatch plugin hook for task start
    try {
      getPluginLifecycleHooks().dispatchOnScheduledTaskStart(task.id, executionId)
    } catch {
      /* plugin system may not be initialized */
    }

    log.info(`Executing task: ${task.name} (execution: ${executionId})`)

    try {
      // Get executor. Subsystems register their executors from their own boot
      // chunk, so shortly after scheduler start a persisted task can come due
      // before its executor exists — wait (bounded) instead of failing.
      let executor = executors.get(task.type)
      if (!executor) {
        const graceRemaining = this.startedAtMs + EXECUTOR_REGISTRATION_GRACE_MS - Date.now()
        if (graceRemaining > 0 && !isDeprecatedTaskType(task.type)) {
          execution.logs.push(
            this.createLog(
              "info",
              `No executor registered for "${task.type}" yet — waiting up to ${Math.ceil(graceRemaining / 1000)}s for boot registration`
            )
          )
          await waitForTaskExecutor(task.type, graceRemaining, controller.signal)
          executor = executors.get(task.type)
        }
      }
      if (!executor) {
        throw SchedulerError.executorNotFound(task.type)
      }

      // Execute with timeout (controller is shared with cancel-previous aborts)
      const result = await this.executeWithTimeout(
        (signal) => executor(task, execution, signal),
        task.config.timeout,
        controller
      )

      // Update execution
      execution.status = result.success ? "completed" : "failed"
      execution.output = result.output
      execution.error = result.success
        ? undefined
        : result.error || "Executor returned unsuccessful result"
      execution.completedAt = new Date()
      execution.duration = execution.completedAt.getTime() - startTime.getTime()
      execution.terminalReason =
        result.terminalReason ?? (result.success ? "completed" : "executor-failure")
      execution.logs.push(
        this.createLog(
          result.success ? "info" : "error",
          result.success ? "Task completed successfully" : `Task failed: ${execution.error}`
        )
      )

      // Update task statistics
      await this.updateTaskStats(task, execution, context.scheduledSlotClaimed === true)

      // Notify completion
      if (result.success && task.notification.onComplete) {
        await notifyTaskEvent(task, execution, "complete")
      } else if (!result.success && task.notification.onError) {
        await notifyTaskEvent(task, execution, "error")
      }

      // Emit scheduler events for event-triggered task chaining
      const eventType = result.success ? (`${task.type}:completed` as const) : undefined
      if (eventType) {
        emitSchedulerEvent(
          eventType === "workflow:completed" ||
            eventType === "agent:completed" ||
            eventType === "backup:completed" ||
            eventType === "sync:completed" ||
            eventType === "goal:completed" ||
            eventType === "agent-team:completed" ||
            eventType === "plan:completed"
            ? eventType
            : "custom",
          {
            taskId: task.id,
            taskName: task.name,
            executionId: execution.id,
            output: result.output,
          },
          task.type
        ).catch((err) => log.error("Failed to emit post-execution event:", err))
      }

      // Dispatch plugin hooks for completion/failure
      try {
        if (result.success) {
          getPluginLifecycleHooks().dispatchOnScheduledTaskComplete(task.id, executionId, {
            success: true,
            output: result.output,
          })
        } else {
          getPluginLifecycleHooks().dispatchOnScheduledTaskError(
            task.id,
            executionId,
            new Error(execution.error || "Unknown error")
          )
        }
      } catch {
        /* plugin system may not be initialized */
      }

      log.info(
        `Task ${task.name} ${result.success ? "completed" : "failed"} in ${execution.duration}ms`
      )

      // Trigger dependent tasks on success
      if (result.success) {
        this.triggerDependentTasks(task, "success").catch((err) => {
          log.error("Failed to trigger dependent tasks:", err)
        })
      } else if (
        retryAttempt < task.config.maxRetries &&
        taskLifecycleVersion === this.getTaskLifecycleVersion(task.id)
      ) {
        const delay = this.calculateRetryDelay(task.config, retryAttempt)
        shouldRetry = true
        nextRetryAt = new Date(Date.now() + delay)
        execution.retryScheduledAt = nextRetryAt
        execution.terminalReason = "retry-scheduled"
        execution.logs.push(
          this.createLog(
            "info",
            `Scheduling retry ${retryAttempt + 1}/${task.config.maxRetries} in ${Math.round(delay / 1000)}s`
          )
        )
        this.retryChains.add(task.id)
        this.scheduleRetry(
          task,
          retryAttempt + 1,
          nextRetryAt,
          context.deferNextRunUpdate,
          context.scheduledSlotClaimed,
          delay,
          executionLifecycleVersion,
          taskLifecycleVersion
        )
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      const isCancelled = error instanceof SchedulerError && error.code === "EXECUTION_CANCELLED"

      execution.status = isCancelled ? "cancelled" : "failed"
      execution.error = errorMessage
      execution.completedAt = new Date()
      execution.duration = execution.completedAt.getTime() - startTime.getTime()
      execution.terminalReason = this.getTerminalReasonFromError(error)
      execution.logs.push(
        this.createLog(isCancelled ? "warn" : "error", `Execution error: ${errorMessage}`)
      )

      log.error(`Task ${task.name} failed with error:`, error)

      // Dispatch plugin hook for error
      try {
        getPluginLifecycleHooks().dispatchOnScheduledTaskError(
          task.id,
          executionId,
          new Error(errorMessage)
        )
      } catch {
        /* plugin system may not be initialized */
      }

      // Notify error
      if (task.notification.onError) {
        await notifyTaskEvent(task, execution, "error")
      }

      // Handle retry with exponential backoff + jitter.
      // Timeouts and overlap-cancellations are terminal — never retried.
      const isTimeout = error instanceof SchedulerError && error.code === "EXECUTION_TIMEOUT"
      if (
        !isTimeout &&
        !isCancelled &&
        retryAttempt < task.config.maxRetries &&
        taskLifecycleVersion === this.getTaskLifecycleVersion(task.id)
      ) {
        const delay = this.calculateRetryDelay(task.config, retryAttempt)
        shouldRetry = true
        nextRetryAt = new Date(Date.now() + delay)
        execution.retryScheduledAt = nextRetryAt
        execution.terminalReason = "retry-scheduled"
        execution.logs.push(
          this.createLog(
            "info",
            `Scheduling retry ${retryAttempt + 1}/${task.config.maxRetries} in ${Math.round(delay / 1000)}s`
          )
        )
        this.retryChains.add(task.id)
        this.scheduleRetry(
          task,
          retryAttempt + 1,
          nextRetryAt,
          context.deferNextRunUpdate,
          context.scheduledSlotClaimed,
          delay,
          executionLifecycleVersion,
          taskLifecycleVersion
        )
      }

      // Update task statistics
      await this.updateTaskStats(task, execution, context.scheduledSlotClaimed === true)
    } finally {
      this.untrackRunning(execution)
      this.executionControllers.delete(executionId)
      await schedulerDb.updateExecution(execution)
      this.broadcastExecutionStatus(execution)

      if (!shouldRetry) {
        this.retryChains.delete(task.id)

        if (executionLifecycleVersion !== this.lifecycleVersion) {
          return execution
        }

        // Forward failure chain fires only on a *terminal* failure (cancelled
        // runs were displaced, not failed — they trigger nothing).
        if (execution.status === "failed") {
          this.triggerDependentTasks(task, "failure").catch((err) => {
            log.error("Failed to trigger failure-chain tasks:", err)
          })
        }

        if (context.scheduledSlotClaimed) {
          await this.finalizeClaimedScheduledRun(task)
        } else if (!context.deferNextRunUpdate) {
          const referenceDate = execution.scheduledFor ?? execution.startedAt
          await this.updateNextRunTime(task, {
            fromDate: referenceDate,
            intervalBase: referenceDate,
          })
        }

        // Drain one buffered start (queue-one / queue-all). A retry chain is a
        // continuation of the same logical run, so draining waits for it.
        this.drainQueuedStart(task.id)
      }
    }

    return execution
  }

  private scheduleRetry(
    task: ScheduledTask,
    retryAttempt: number,
    scheduledFor: Date,
    deferNextRunUpdate: boolean | undefined,
    scheduledSlotClaimed: boolean | undefined,
    delay: number,
    lifecycleVersion: number,
    taskLifecycleVersion: number
  ): void {
    const timer = setTimeout(() => {
      const timers = this.retryTimers.get(task.id)
      timers?.delete(timer)
      if (timers?.size === 0) this.retryTimers.delete(task.id)

      if (
        lifecycleVersion !== this.lifecycleVersion ||
        taskLifecycleVersion !== this.getTaskLifecycleVersion(task.id)
      ) {
        this.retryChains.delete(task.id)
        return
      }

      void schedulerDb
        .getTask(task.id)
        .then((latest) => {
          if (
            !latest ||
            latest.status !== "active" ||
            lifecycleVersion !== this.lifecycleVersion ||
            taskLifecycleVersion !== this.getTaskLifecycleVersion(task.id)
          ) {
            this.retryChains.delete(task.id)
            return
          }
          return this.executeTask(latest, retryAttempt, {
            triggerSource: "retry",
            scheduledFor,
            deferNextRunUpdate,
            scheduledSlotClaimed,
          })
        })
        .catch((err) => {
          this.retryChains.delete(task.id)
          log.error(`Retry failed for task ${task.name}:`, err)
        })
    }, delay)

    const timers = this.retryTimers.get(task.id) ?? new Set()
    timers.add(timer)
    this.retryTimers.set(task.id, timers)
  }

  private getTaskLifecycleVersion(taskId: string): number {
    return this.taskLifecycleVersions.get(taskId) ?? 0
  }

  private invalidateTaskLifecycle(taskId: string): void {
    this.taskLifecycleVersions.set(taskId, this.getTaskLifecycleVersion(taskId) + 1)
  }

  private clearTaskRetries(taskId: string): void {
    const timers = this.retryTimers.get(taskId)
    if (timers) {
      for (const timer of timers) clearTimeout(timer)
      this.retryTimers.delete(taskId)
    }
    this.retryChains.delete(taskId)
  }

  /**
   * Pop and run the FIFO head of a task's buffered-start queue. Each drained
   * run drains the next on its own completion (via its `finally`).
   */
  private drainQueuedStart(taskId: string): void {
    if (this.retryChains.has(taskId)) return
    const queue = this.queues.get(taskId)
    if (!queue || queue.length === 0) {
      this.queues.delete(taskId)
      return
    }
    const next = queue.shift()!
    if (queue.length === 0) this.queues.delete(taskId)

    void schedulerDb
      .getTask(taskId)
      .then((latest) => {
        if (!latest) return
        return this.executeTask(latest, 0, {
          triggerSource: next.triggerSource,
          scheduledFor: next.scheduledFor,
          deferNextRunUpdate: next.deferNextRunUpdate,
          scheduledSlotClaimed: next.scheduledSlotClaimed,
        })
      })
      .catch((err) => {
        log.error(`Error executing buffered start for task ${taskId}:`, err)
      })
  }

  /**
   * Synthetic (non-persisted) execution returned to the caller when a start is
   * buffered by a queue overlap policy. A real execution record is created
   * when the buffered start actually runs.
   */
  private createQueuedPlaceholderExecution(
    task: ScheduledTask,
    executionId: string,
    queued: QueuedStart
  ): TaskExecution {
    const now = new Date()
    return {
      id: executionId,
      taskId: task.id,
      taskName: task.name,
      taskType: task.type,
      status: "pending",
      retryAttempt: 0,
      triggerSource: queued.triggerSource,
      scheduledFor: queued.scheduledFor,
      startedAt: now,
      logs: [
        this.createLog(
          "info",
          "Start buffered by overlap policy; it will run when the current execution finishes"
        ),
      ],
    }
  }

  /**
   * Execute a function with timeout using AbortController. The controller may
   * be externally owned (per-execution) so the `cancel-previous` overlap
   * policy can abort a running execution; the abort reason distinguishes a
   * timeout from an overlap cancellation.
   */
  private async executeWithTimeout<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    controller: AbortController = new AbortController()
  ): Promise<T> {
    const timer = setTimeout(() => controller.abort("execution-timeout"), timeoutMs)
    const abortError = () => {
      const reason = controller.signal.reason
      return reason === "overlap-cancelled"
        ? SchedulerError.executionCancelled("task", "overlap-cancelled")
        : reason === "scheduler-stopped"
          ? SchedulerError.executionCancelled("task", "scheduler-stopped")
          : reason === "task-deleted"
            ? SchedulerError.executionCancelled("task", "task-deleted")
            : SchedulerError.executionTimeout("task", timeoutMs)
    }

    try {
      if (controller.signal.aborted) {
        throw abortError()
      }
      const result = await Promise.race([
        fn(controller.signal),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(abortError()), { once: true })
        }),
      ])
      return result
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Update task statistics after execution
   */
  private async updateTaskStats(
    task: ScheduledTask,
    execution: TaskExecution,
    runBudgetReserved: boolean = false
  ): Promise<void> {
    const latestTask = await schedulerDb.getTask(task.id)
    // Deletion is terminal. Never recreate a task row from the execution's
    // stale snapshot after deleteTask removed it.
    if (!latestTask) return
    const baseTask = latestTask
    const updates: Partial<ScheduledTask> = {
      // Scheduled slots reserve their run budget inside `claimTaskSlot` before
      // execution. Completion and retry attempts must not consume it again.
      runCount: runBudgetReserved ? baseTask.runCount : baseTask.runCount + 1,
      lastRunAt: execution.startedAt,
      lastTerminalReason: execution.terminalReason,
      lastTerminalAt: execution.completedAt ?? new Date(),
      updatedAt: new Date(),
    }

    let autoPaused = false
    if (execution.status === "completed") {
      updates.successCount = baseTask.successCount + 1
      updates.lastError = undefined
      updates.consecutiveFailures = 0
    } else if (execution.status === "failed") {
      updates.failureCount = baseTask.failureCount + 1
      updates.lastError = execution.error
      // A retry chain counts as ONE logical failure: only the terminal attempt
      // (no further retry scheduled) increments the consecutive counter.
      if (execution.terminalReason !== "retry-scheduled") {
        const consecutive = (baseTask.consecutiveFailures ?? 0) + 1
        updates.consecutiveFailures = consecutive
        const threshold = baseTask.config.pauseAfterConsecutiveFailures
        if (typeof threshold === "number" && threshold > 0 && consecutive >= threshold) {
          autoPaused = true
          updates.status = "paused"
          updates.lastTerminalReason = "auto-paused"
        }
      }
    }

    const updatedTask = { ...baseTask, ...updates }
    await schedulerDb.updateTask(updatedTask)

    if (autoPaused) {
      this.unscheduleTask(task.id)
      this.queues.delete(task.id)
      log.warn(
        `Task ${task.name} auto-paused after ${updates.consecutiveFailures} consecutive failures`
      )
      await notifyTaskEvent(updatedTask, execution, "auto-paused")
    }
  }

  /**
   * Update the next run time for a task and reschedule
   */
  private async updateNextRunTime(
    task: ScheduledTask,
    options: { fromDate?: Date; intervalBase?: Date } = {}
  ): Promise<void> {
    // Re-fetch the latest row: `task` may be a pre-execution snapshot, and a
    // wholesale put from it would clobber stats / status written by
    // `updateTaskStats` (runCount, auto-pause, consecutiveFailures).
    const latest = await schedulerDb.getTask(task.id)
    if (!latest) return

    // Lifecycle bounds: a task that just consumed its maxRuns budget (or whose
    // endAt passed) expires instead of re-arming.
    if (latest.status === "active" && (isPastEndAt(latest, new Date()) || isAtMaxRuns(latest))) {
      await this.expireTask(latest, isAtMaxRuns(latest) ? "max-runs-reached" : "ended")
      return
    }

    const nextRunAt = this.calculateNextRunTime(latest, options)

    if (nextRunAt) {
      await schedulerDb.updateTask({
        ...latest,
        nextRunAt,
        updatedAt: new Date(),
      })

      // Reschedule
      if (latest.status === "active") {
        await this.scheduleTask({ ...latest, nextRunAt })
      }
    } else if (latest.trigger.type === "once") {
      // One-time task completed, mark as expired
      await schedulerDb.updateTask({
        ...latest,
        status: "expired",
        updatedAt: new Date(),
      })
    }
  }

  /**
   * A normal due event advances nextRunAt before execution through the DB
   * claim transaction. Completion must therefore only enforce terminal
   * lifecycle rules; recalculating from the old slot could move a task
   * backwards after a later overlapping slot has already been claimed.
   */
  private async finalizeClaimedScheduledRun(task: ScheduledTask): Promise<void> {
    const latest = await schedulerDb.getTask(task.id)
    if (!latest) return
    if (latest.status !== "active") return
    if (latest.trigger.type === "once") {
      await schedulerDb.updateTask({
        ...latest,
        status: "expired",
        nextRunAt: undefined,
        updatedAt: new Date(),
      })
      return
    }
    if (isPastEndAt(latest, new Date()) || isAtMaxRuns(latest)) {
      await this.expireTask(latest, isAtMaxRuns(latest) ? "max-runs-reached" : "ended")
    }
  }

  /**
   * Calculate the next run time for a task
   */
  private calculateNextRunTime(
    task: ScheduledTask,
    options: { fromDate?: Date; intervalBase?: Date } = {}
  ): Date | undefined {
    const trigger = task.trigger
    const now = options.fromDate ?? new Date()

    switch (trigger.type) {
      case "cron":
        if (trigger.cronExpression) {
          return getNextCronTime(trigger.cronExpression, now, trigger.timezone) || undefined
        }
        break

      case "interval":
        if (trigger.intervalMs && trigger.intervalMs > 0) {
          const baseTime = options.intervalBase || task.lastRunAt || task.createdAt
          if (!baseTime) {
            return new Date(now.getTime() + trigger.intervalMs)
          }

          if (baseTime.getTime() >= now.getTime()) {
            return new Date(baseTime.getTime() + trigger.intervalMs)
          }

          const elapsed = now.getTime() - baseTime.getTime()
          const intervalsElapsed = Math.floor(elapsed / trigger.intervalMs) + 1
          return new Date(baseTime.getTime() + intervalsElapsed * trigger.intervalMs)
        }
        break

      case "once":
        if (trigger.runAt && trigger.runAt > now) {
          return trigger.runAt
        }
        break

      case "event":
        // Event-based tasks don't have a scheduled time
        return undefined
    }

    return undefined
  }

  private getNextRunAfter(trigger: TaskTrigger, reference: Date): Date | undefined {
    switch (trigger.type) {
      case "cron":
        return trigger.cronExpression
          ? getNextCronTime(trigger.cronExpression, reference, trigger.timezone) || undefined
          : undefined
      case "interval":
        return trigger.intervalMs && trigger.intervalMs > 0
          ? new Date(reference.getTime() + trigger.intervalMs)
          : undefined
      case "once":
        return trigger.runAt && trigger.runAt > reference ? trigger.runAt : undefined
      case "event":
        return undefined
      default:
        return undefined
    }
  }

  /**
   * Calculate retry delay using exponential backoff with jitter
   * Formula: min(baseDelay * 2^attempt + random_jitter, maxDelay)
   */
  private calculateRetryDelay(config: TaskExecutionConfig, attempt: number): number {
    return computeBackoffDelay(attempt, {
      baseDelayMs: config.retryDelay,
      maxDelayMs: config.maxRetryDelay || 60000,
      // 0-25% of the exponential delay, to prevent thundering herd.
      jitter: { kind: "ratio", ratio: 0.25, rng: this.rng },
    })
  }

  /**
   * Create a log entry
   */
  private createLog(
    level: TaskExecutionLog["level"],
    message: string,
    data?: unknown
  ): TaskExecutionLog {
    return {
      id: nanoid(),
      timestamp: new Date(),
      level,
      message,
      data,
    }
  }

  private getTerminalReasonFromError(error: unknown): string {
    if (error instanceof SchedulerError && error.code === "EXECUTION_TIMEOUT") {
      return "execution-timeout"
    }
    if (error instanceof SchedulerError && error.code === "EXECUTION_CANCELLED") {
      if (error.details?.reason === "scheduler-stopped") return "scheduler-stopped"
      if (error.details?.reason === "task-deleted") return "task-deleted"
      return "overlap-cancelled"
    }
    if (error instanceof SchedulerError && error.code === "EXECUTOR_NOT_FOUND") {
      return "executor-not-found"
    }
    return "execution-error"
  }

  private async createSkippedExecution(
    task: ScheduledTask,
    params: {
      triggerSource: TaskExecutionTriggerSource
      scheduledFor?: Date
      terminalReason: string
      message: string
      retryAttempt?: number
    }
  ): Promise<TaskExecution> {
    const now = new Date()
    const skippedExecution: TaskExecution = {
      id: nanoid(),
      taskId: task.id,
      taskName: task.name,
      taskType: task.type,
      status: "skipped",
      retryAttempt: params.retryAttempt ?? 0,
      triggerSource: params.triggerSource,
      scheduledFor: params.scheduledFor,
      terminalReason: params.terminalReason,
      startedAt: now,
      completedAt: now,
      duration: 0,
      logs: [this.createLog("info", params.message)],
    }
    await schedulerDb.createExecution(skippedExecution)
    this.broadcastExecutionStatus(skippedExecution)
    return skippedExecution
  }

  /** Track task IDs currently being triggered via dependency chain to detect cycles */
  private dependencyChainVisited: Set<string> = new Set()

  /**
   * Trigger tasks chained to the finished task.
   *
   * - `success`: inverse `dependsOn` dependents (success-gated AND-join,
   *   unchanged behavior) plus the forward `onSuccessTaskIds` list.
   * - `failure`: the forward `onFailureTaskIds` list only.
   *
   * Forward chains are fire-and-forget (no AND-join). Both directions share
   * the cycle guard so a task appearing on multiple edges fires once.
   */
  private async triggerDependentTasks(
    sourceTask: ScheduledTask,
    outcome: "success" | "failure"
  ): Promise<void> {
    const sourceTaskId = sourceTask.id
    // Cycle detection: if this task is already in the chain, abort
    if (this.dependencyChainVisited.has(sourceTaskId)) {
      log.warn(`Dependency cycle detected at task ${sourceTaskId}, aborting chain`)
      return
    }

    this.dependencyChainVisited.add(sourceTaskId)

    try {
      const firedTaskIds = new Set<string>()

      if (outcome === "success") {
        const activeTasks = await schedulerDb.getTasksByStatus("active")
        const dependentTasks = activeTasks.filter(
          (t) => t.trigger.dependsOn && t.trigger.dependsOn.includes(sourceTaskId)
        )

        for (const depTask of dependentTasks) {
          // Skip if this dependent task is already in the chain (another cycle check)
          if (this.dependencyChainVisited.has(depTask.id)) {
            log.warn(`Skipping task "${depTask.name}" to prevent dependency cycle`)
            continue
          }

          const allDepsComplete = await this.checkAllDependenciesComplete(depTask)
          if (allDepsComplete) {
            log.info(`All dependencies met for task "${depTask.name}", triggering execution`)
            firedTaskIds.add(depTask.id)
            this.executeTask(depTask, 0, { triggerSource: "dependency" }).catch((err) => {
              log.error(`Error executing dependent task ${depTask.name}:`, err)
            })
          }
        }
      }

      const forwardIds =
        outcome === "success" ? sourceTask.onSuccessTaskIds : sourceTask.onFailureTaskIds
      for (const targetId of forwardIds ?? []) {
        if (firedTaskIds.has(targetId)) continue
        if (this.dependencyChainVisited.has(targetId)) {
          log.warn(`Skipping forward-chain target ${targetId} to prevent dependency cycle`)
          continue
        }
        const target = await schedulerDb.getTask(targetId)
        if (!target) {
          log.warn(`Forward-chain target ${targetId} not found, skipping`)
          continue
        }
        if (target.status !== "active") {
          log.warn(`Forward-chain target "${target.name}" is ${target.status}, skipping`)
          continue
        }
        log.info(`Forward ${outcome} chain firing task "${target.name}"`)
        firedTaskIds.add(targetId)
        this.executeTask(target, 0, { triggerSource: "dependency" }).catch((err) => {
          log.error(`Error executing forward-chain task ${target.name}:`, err)
        })
      }
    } catch (error) {
      log.error("Error checking dependent tasks:", error)
    } finally {
      this.dependencyChainVisited.delete(sourceTaskId)
    }
  }

  /**
   * Check if all dependency tasks have completed successfully (most recent execution)
   */
  private async checkAllDependenciesComplete(task: ScheduledTask): Promise<boolean> {
    const deps = task.trigger.dependsOn
    if (!deps || deps.length === 0) return true

    for (const depTaskId of deps) {
      const depTask = await schedulerDb.getTask(depTaskId)
      if (!depTask) return false
      if (!depTask.lastRunAt) return false

      const executions = await schedulerDb.getTaskExecutions(depTaskId, 1)
      if (executions.length === 0) return false

      const lastExec = executions[0]
      if (lastExec.status !== "completed") return false
    }
    return true
  }

  /**
   * Trigger an event-based task
   */
  async triggerEventTask(
    eventType: string,
    eventSource?: string,
    payload?: Record<string, unknown>
  ): Promise<void> {
    // Use targeted query instead of loading all tasks
    const eventTasks = await schedulerDb.getActiveEventTasks(eventType)

    for (const task of eventTasks) {
      if (!task.trigger.eventSource || task.trigger.eventSource === eventSource) {
        log.info(`Event ${eventType} triggered task: ${task.name}`)

        // Merge event payload with task payload
        const mergedPayload = {
          ...task.payload,
          event: { type: eventType, source: eventSource, data: payload },
        }
        const taskWithPayload = { ...task, payload: mergedPayload }

        this.executeTask(taskWithPayload, 0, { triggerSource: "event" }).catch((err) => {
          log.error(`Error executing event-triggered task ${task.name}:`, err)
        })
      }
    }
  }

  /**
   * Export all tasks as a JSON-serializable object (excludes execution history)
   */
  async exportTasks(
    taskIds?: string[]
  ): Promise<{ version: number; exportedAt: string; tasks: ScheduledTask[] }> {
    let tasks: ScheduledTask[]
    if (taskIds && taskIds.length > 0) {
      const allTasks = await schedulerDb.getAllTasks()
      tasks = allTasks.filter((t) => taskIds.includes(t.id))
    } else {
      tasks = await schedulerDb.getAllTasks()
    }

    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      tasks,
    }
  }

  /**
   * Import tasks from an exported JSON object
   * @param mode 'merge' keeps existing tasks, 'replace' deletes all before import
   */
  async importTasks(
    data: { version: number; tasks: ScheduledTask[] },
    mode: "merge" | "replace" = "merge"
  ): Promise<{ imported: number; skipped: number; errors: string[] }> {
    const result = { imported: 0, skipped: 0, errors: [] as string[] }

    if (!data?.version || !Array.isArray(data.tasks)) {
      result.errors.push("Invalid import format: missing version or tasks array")
      return result
    }

    if (mode === "replace") {
      const existingTasks = await schedulerDb.getAllTasks()
      for (const task of existingTasks) {
        this.unscheduleTask(task.id)
        await schedulerDb.deleteTask(task.id)
      }
    }

    for (const task of data.tasks) {
      try {
        if (!task.name || !task.type || !task.trigger) {
          result.errors.push(`Skipped invalid task: ${task.name || task.id || "unknown"}`)
          result.skipped++
          continue
        }

        if (mode === "merge") {
          const existing = await schedulerDb.getTask(task.id)
          if (existing) {
            result.skipped++
            continue
          }
        }

        const importedTask: ScheduledTask = {
          ...task,
          trigger: normalizeTaskTrigger(task.trigger, { now: new Date() }),
          payload: normalizeConversationalTaskPayload(task.type, task.payload),
          config: {
            ...DEFAULT_EXECUTION_CONFIG,
            ...task.config,
            maxMissedRuns: Math.max(
              0,
              task.config?.maxMissedRuns ?? DEFAULT_EXECUTION_CONFIG.maxMissedRuns ?? 1
            ),
          },
          notification: {
            ...DEFAULT_NOTIFICATION_CONFIG,
            ...task.notification,
          },
          createdAt: new Date(task.createdAt),
          updatedAt: new Date(),
          lastRunAt: undefined,
          nextRunAt: undefined,
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          lastError: undefined,
          lastTerminalReason: undefined,
          lastTerminalAt: undefined,
          status: "active",
        }

        importedTask.nextRunAt = this.calculateNextRunTime(importedTask, { fromDate: new Date() })
        await schedulerDb.createTask(importedTask)

        if (importedTask.status === "active" && this.isTimingAuthority()) {
          await this.scheduleTask(importedTask)
        }

        result.imported++
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        result.errors.push(`Failed to import task "${task.name}": ${msg}`)
      }
    }

    log.info(
      `Import complete: ${result.imported} imported, ${result.skipped} skipped, ${result.errors.length} errors`
    )
    return result
  }

  /**
   * Get scheduler status
   */
  getStatus(): { initialized: boolean; scheduledCount: number; runningCount: number } {
    let runningCount = 0
    for (const perTask of this.runningByTask.values()) {
      runningCount += perTask.size
    }
    return {
      initialized: this.isInitialized,
      scheduledCount: this.armedTaskIds.size,
      runningCount,
    }
  }
}

// Singleton instance
let schedulerInstance: TaskSchedulerImpl | null = null

/**
 * Create a new task scheduler instance (factory pattern).
 * Useful for testing or creating isolated scheduler instances.
 */
export function createTaskScheduler(
  driver?: SchedulerTimingDriver,
  opts: { rng?: () => number } = {}
): TaskSchedulerImpl {
  return new TaskSchedulerImpl(driver, opts)
}

/**
 * Get the task scheduler singleton instance.
 * Creates one if it doesn't exist yet.
 */
export function getTaskScheduler(): TaskSchedulerImpl {
  if (!schedulerInstance) {
    schedulerInstance = createTaskScheduler()
  }
  return schedulerInstance
}

/**
 * Initialize the task scheduler
 */
export async function initTaskScheduler(driver?: SchedulerTimingDriver): Promise<void> {
  if (driver) {
    schedulerInstance?.stop()
    schedulerInstance = createTaskScheduler(driver)
  }
  const scheduler = getTaskScheduler()
  await scheduler.initialize()
}

/**
 * Stop the task scheduler
 */
export function stopTaskScheduler(): void {
  if (schedulerInstance) {
    schedulerInstance.stop()
    schedulerInstance = null
  }
}

export { TaskSchedulerImpl }
