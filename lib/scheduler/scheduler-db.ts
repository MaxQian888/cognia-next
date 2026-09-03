/**
 * Scheduler persistence.
 *
 * The two stores live in the ACCOUNT database (`CogniaDB`, schema v219) as
 * `scheduledTasks` / `scheduledTaskRuns`. They used to be a standalone Dexie
 * database named `CogniaSchedulerDB`, which meant a schedule was shared across
 * accounts, stored its prompts and webhook URLs in the clear, sat outside the
 * data-governance catalog, and was silently absent from every backup. Folding
 * it into the account database fixes all four at once.
 *
 * What did NOT change is placement: ADR-0128 decision 6 says every host keeps
 * its own schedule and nothing hands tasks between hosts. The account database
 * is still local to its host, and `scheduler-host-target.ts` still routes a
 * client to a paired host over `scheduled_task_*` RPCs. Account scoping and
 * host placement are different axes.
 *
 * `SchedulerDatabase` survives as a facade over that database so the ~60 call
 * sites keep their method surface. It is deliberately NOT a Dexie subclass any
 * more, so anything that needs raw Dexie behaviour has to ask for it here (see
 * `transaction`) rather than reaching through a table handle.
 */

import Dexie from "dexie"
import type { EntityTable } from "dexie"
import type {
  ScheduledTask,
  ScheduledTaskType,
  TaskExecution,
  ScheduledTaskStatus,
  TaskFilter,
  TaskStatistics,
} from "@/types/scheduler"
import type { DBScheduledTask, DBTaskExecution } from "@/lib/db/scheduled-task-types"
import { getDb } from "@/lib/db/schema"
import { loggers } from "@cognia/logging"

const log = loggers.app

/**
 * Scheduler tables a headless host deliberately does NOT snapshot.
 *
 * `cli/src/db/bootstrap.ts` snapshots Dexie to a JSON file and every mutation
 * schedules a re-dump, so a high-churn table makes the snapshot cost grow with
 * uptime. `scheduledTasks` is low-churn configuration and MUST survive a
 * restart. Without it a `cognia serve` brain reboots with an empty schedule and
 * silently stops firing. `scheduledTaskRuns` is append-heavy history the brain
 * does not need across restarts: failures are already durable in
 * `connectorAudit` and the Notification Center, and `interruptStaleExecutions()`
 * has nothing to reconcile when the table starts empty.
 *
 * This is intentional dormancy, so it is labelled on all three axes: here at
 * the type, in the snapshot source that consumes it, and pinned by
 * `scheduler-db.test.ts` / `bootstrap.test.ts`. Do not "fix" it by adding the
 * runs table to the snapshot. Measure the flush cost first (see W3.1).
 *
 * Since v219 these are tables of the ACCOUNT database, so the exclusion is
 * applied to the primary snapshot source rather than to a second database.
 */
export const SCHEDULER_SNAPSHOT_EXCLUDED_TABLES: readonly string[] = ["scheduledTaskRuns"]

/**
 * Name of the LEGACY standalone scheduler database.
 *
 * Nothing writes it any more. It survives so `legacy-db-migration.ts` can
 * recognise a pre-v219 install, drain it into the account database, and delete
 * it. Do not reintroduce it as a storage target.
 */
export const LEGACY_SCHEDULER_DB_NAME = "CogniaSchedulerDB"

/**
 * Facade over the account database's two scheduler stores.
 *
 * Not a Dexie subclass. `tasks` / `executions` are getters that resolve
 * `getDb()` on every access rather than capturing a handle, because the active
 * account database is swapped wholesale on account switch and lock
 * (`activateAccountDatabase` / `closeCachedDb` in `lib/db/schema.ts`). A
 * captured handle would keep serving the previous account's rows.
 *
 * Both getters are `private`: a caller outside this module that reaches for a
 * raw table handle bypasses the (de)serialization below and would read the
 * stored shape, not a `ScheduledTask`. Use the methods, or add one.
 */
class SchedulerDatabase {
  private get tasks(): EntityTable<DBScheduledTask, "id"> {
    return getDb().scheduledTasks as unknown as EntityTable<DBScheduledTask, "id">
  }

  private get executions(): EntityTable<DBTaskExecution, "id"> {
    return getDb().scheduledTaskRuns as unknown as EntityTable<DBTaskExecution, "id">
  }

  /**
   * Delegate to the account database's transaction.
   *
   * The three internal callers open `rw` over both scheduler stores. Now that
   * the stores are tables of the SAME Dexie instance, that transaction is a
   * genuine one rather than two databases updated in sequence, so a failed
   * `deleteTask` can no longer leave executions orphaned behind a deleted task.
   */
  private transaction<T>(
    mode: "r" | "rw",
    tables: unknown,
    scope: () => PromiseLike<T> | T
  ): PromiseLike<T> {
    return getDb().transaction(
      mode as "rw",
      tables as Parameters<ReturnType<typeof getDb>["transaction"]>[1],
      scope as () => Promise<T>
    ) as PromiseLike<T>
  }

  /**
   * Raw stored rows, for callers that only need a cheap shape-agnostic read.
   *
   * `lib/boot/startup-probe.ts` wants "is anything scheduled, and is any of it
   * active" and nothing else. Running every row through `deserializeTask` for
   * that would parse six JSON blobs per task during boot.
   */
  async listStoredTasks(): Promise<DBScheduledTask[]> {
    return this.tasks.toArray()
  }

  // ========== Task Operations ==========

  /**
   * Create a new task
   */
  async createTask(task: ScheduledTask): Promise<void> {
    await this.tasks.add(serializeTask(task))
  }

  /**
   * Update an existing task
   */
  async updateTask(task: ScheduledTask): Promise<void> {
    await this.tasks.put(serializeTask(task))
  }

  /**
   * Delete a task and its executions
   */
  async deleteTask(taskId: string): Promise<boolean> {
    const task = await this.tasks.get(taskId)
    if (!task) return false

    await this.transaction("rw", [this.tasks, this.executions], () =>
      Promise.all([
        this.executions.where("taskId").equals(taskId).delete(),
        this.tasks.delete(taskId),
      ]).then(() => undefined)
    )

    return true
  }

  /**
   * Get a task by ID
   */
  async getTask(taskId: string): Promise<ScheduledTask | null> {
    const dbTask = await this.tasks.get(taskId)
    return dbTask ? deserializeTask(dbTask) : null
  }

  /**
   * Atomically claim one persisted schedule slot and advance the task to its
   * next slot. The transaction also reserves one run from `maxRuns` before any
   * execution starts, so a short interval cannot admit several overlapping
   * runs against the same remaining budget. Exactly one renderer/process
   * callback can win for a given `(taskId, expectedRunAt)` pair.
   */
  async claimTaskSlot(
    taskId: string,
    expectedRunAt: Date,
    nextRunAt?: Date
  ): Promise<ScheduledTask | null> {
    return this.transaction("rw", this.tasks, async () => {
      const dbTask = await this.tasks.get(taskId)
      if (
        !dbTask ||
        dbTask.status !== "active" ||
        dbTask.nextRunAt !== expectedRunAt.toISOString()
      ) {
        return null
      }

      const config = JSON.parse(dbTask.config) as ScheduledTask["config"]
      const maxRuns = config.maxRuns
      if (typeof maxRuns === "number" && maxRuns > 0 && dbTask.runCount >= maxRuns) {
        return null
      }
      const runCount = dbTask.runCount + 1
      const exhaustedBudget = typeof maxRuns === "number" && maxRuns > 0 && runCount >= maxRuns
      const claimed: DBScheduledTask = {
        ...dbTask,
        runCount,
        // Do not expose another slot once this reservation consumes the final
        // budget. The in-flight run finalizes the task as expired.
        nextRunAt: exhaustedBudget ? undefined : nextRunAt?.toISOString(),
        updatedAt: new Date().toISOString(),
      }
      await this.tasks.put(claimed)
      return deserializeTask(claimed)
    })
  }

  /**
   * Get all tasks
   */
  async getAllTasks(): Promise<ScheduledTask[]> {
    const dbTasks = await this.tasks.toArray()
    return dbTasks.map(safeDeserializeTask).filter((t): t is ScheduledTask => t !== null)
  }

  /**
   * Get tasks by status
   */
  async getTasksByStatus(status: ScheduledTaskStatus): Promise<ScheduledTask[]> {
    const dbTasks = await this.tasks.where("status").equals(status).toArray()
    return dbTasks.map(safeDeserializeTask).filter((t): t is ScheduledTask => t !== null)
  }

  /**
   * Get tasks by type (any status). Backed by the `type` index.
   */
  async getTasksByType(type: ScheduledTaskType): Promise<ScheduledTask[]> {
    const dbTasks = await this.tasks.where("type").equals(type).toArray()
    return dbTasks.map(safeDeserializeTask).filter((t): t is ScheduledTask => t !== null)
  }

  /**
   * Get tasks with filters
   */
  async getFilteredTasks(filter: TaskFilter): Promise<ScheduledTask[]> {
    let collection = this.tasks.toCollection()

    // Apply filters
    if (filter.statuses && filter.statuses.length > 0) {
      collection = this.tasks.where("status").anyOf(filter.statuses)
    }

    const dbTasks = await collection.toArray()
    let tasks = dbTasks.map(safeDeserializeTask).filter((t): t is ScheduledTask => t !== null)

    // Filter by workspace. A task with no workspace passes every filter: it
    // is unattributed, not foreign, and hiding it would make a schedule that
    // predates the column invisible in every workspace at once.
    if (filter.projectId) {
      tasks = tasks.filter((t) => !t.projectId || t.projectId === filter.projectId)
    }

    // Filter by types
    if (filter.types && filter.types.length > 0) {
      tasks = tasks.filter((t) => filter.types!.includes(t.type))
    }

    // Filter by tags
    if (filter.tags && filter.tags.length > 0) {
      tasks = tasks.filter((t) => t.tags && filter.tags!.some((tag) => t.tags!.includes(tag)))
    }

    // Filter by search
    if (filter.search) {
      const searchLower = filter.search.toLowerCase()
      tasks = tasks.filter(
        (t) =>
          t.name.toLowerCase().includes(searchLower) ||
          t.description?.toLowerCase().includes(searchLower)
      )
    }

    return tasks
  }

  /**
   * Tasks owned by one workspace, plus the unattributed ones.
   *
   * One full read rather than an index query beside it: the unattributed half
   * cannot be indexed (IndexedDB has no index for "absent"), so the table is
   * being scanned regardless and the `projectId` index would only fetch the
   * owned rows a second time. The index still earns its keep for `[projectId+
   * status]` lookups that do not need the unattributed half.
   */
  async getTasksByProject(projectId: string): Promise<ScheduledTask[]> {
    const rows = await this.tasks.toArray()
    return rows
      .filter((row) => !row.projectId || row.projectId === projectId)
      .map(safeDeserializeTask)
      .filter((t): t is ScheduledTask => t !== null)
  }

  /**
   * Stamp the owning workspace onto rows written before scheduler v5.
   *
   * Runs at boot rather than in the upgrade hook: the answer lives in the MAIN
   * database (a creating session's workspace), and reaching across Dexie
   * instances from inside an upgrade transaction is how you get a deadlock.
   *
   * A row whose creator names no session is LEFT ALONE. Stamping it with
   * whatever workspace happened to be active at upgrade time would silently
   * rebind someone's schedule to the wrong repository — for a user with five
   * workspaces it would be wrong four times out of five. Unattributed rows show
   * up everywhere instead, which is visible and correctable.
   *
   * Returns how many rows it stamped. Idempotent.
   */
  async backfillTaskWorkspaces(
    resolveSessionWorkspace: (sessionId: string) => Promise<string | null | undefined>
  ): Promise<number> {
    const rows = await this.tasks.filter((row) => !row.projectId).toArray()
    let stamped = 0
    for (const row of rows) {
      const sessionId = row.createdBy
        ? ((JSON.parse(row.createdBy) as { sessionId?: string }).sessionId ?? null)
        : null
      if (!sessionId) continue
      const projectId = await resolveSessionWorkspace(sessionId).catch(() => null)
      if (!projectId) continue
      await this.tasks.update(row.id, { projectId })
      stamped += 1
    }
    return stamped
  }

  /** Get active event-triggered tasks, optionally filtered by eventType. */
  async getActiveEventTasks(eventType?: string): Promise<ScheduledTask[]> {
    const collection = eventType
      ? this.tasks.where("[status+eventType]").equals(["active", eventType])
      : this.tasks
          .where("[status+eventType]")
          // Empty string is the persisted sentinel for non-event triggers.
          // Excluding the lower bound reads only active event rows.
          .between(["active", ""], ["active", Dexie.maxKey], false, true)
    const dbTasks = await collection.toArray()
    return dbTasks.map(safeDeserializeTask).filter((t): t is ScheduledTask => t !== null)
  }

  /**
   * Active tasks whose nextRunAt is already due (<= now) — used by the
   * missed-task sweep. Uses the `[status+nextRunAt]` compound index instead
   * of fetching every active task and filtering in JS; safe because
   * `nextRunAt` is stored as a fixed-width ISO-8601 string, so lexicographic
   * ordering matches chronological ordering. Tasks with no `nextRunAt` are
   * naturally excluded — a compound-index entry requires every key part.
   */
  async getOverdueActiveTasks(now: Date = new Date()): Promise<ScheduledTask[]> {
    const nowIso = now.toISOString()
    const dbTasks = await this.tasks
      .where("[status+nextRunAt]")
      .between(["active", ""], ["active", nowIso], true, true)
      .toArray()
    return dbTasks.map(safeDeserializeTask).filter((t): t is ScheduledTask => t !== null)
  }

  /**
   * Get upcoming tasks
   */
  async getUpcomingTasks(limit: number = 10): Promise<ScheduledTask[]> {
    const now = new Date().toISOString()
    const dbTasks = await this.tasks
      .where("status")
      .equals("active")
      .filter((t) => t.nextRunAt !== undefined && t.nextRunAt > now)
      .sortBy("nextRunAt")

    return dbTasks
      .slice(0, limit)
      .map(safeDeserializeTask)
      .filter((t): t is ScheduledTask => t !== null)
  }

  // ========== Execution Operations ==========

  /**
   * Create an execution record
   */
  async createExecution(execution: TaskExecution): Promise<void> {
    await this.executions.add(serializeExecution(execution))
  }

  /**
   * Update an execution record
   */
  async updateExecution(execution: TaskExecution): Promise<void> {
    await this.executions.put(serializeExecution(execution))
  }

  /**
   * Get executions for a task with efficient pagination
   * @param beforeStartedAt - cursor for pagination: only return executions started before this ISO string
   */
  async getTaskExecutions(
    taskId: string,
    limit: number = 50,
    beforeStartedAt?: string
  ): Promise<TaskExecution[]> {
    const collection = this.executions.where("[taskId+startedAt]").between(
      [taskId, Dexie.minKey],
      [taskId, beforeStartedAt || Dexie.maxKey],
      true,
      !beforeStartedAt // inclusive upper bound only when no cursor
    )

    const dbExecutions = await collection.reverse().limit(limit).toArray()

    return dbExecutions.map(safeDeserializeExecution).filter((e): e is TaskExecution => e !== null)
  }

  /**
   * Get recent executions across all tasks
   */
  async getRecentExecutions(limit: number = 50): Promise<TaskExecution[]> {
    const dbExecutions = await this.executions.orderBy("startedAt").reverse().limit(limit).toArray()

    return dbExecutions.map(safeDeserializeExecution).filter((e): e is TaskExecution => e !== null)
  }

  /** Get recent executions whose persisted task type belongs to one source. */
  async getRecentExecutionsMatching(
    ownsTaskType: (taskType: string) => boolean,
    limit: number = 50
  ): Promise<TaskExecution[]> {
    const dbExecutions = await this.executions
      .orderBy("startedAt")
      .reverse()
      .filter((execution) => ownsTaskType(execution.taskType))
      .limit(limit)
      .toArray()
    return dbExecutions
      .map(safeDeserializeExecution)
      .filter((execution): execution is TaskExecution => execution !== null)
  }

  /**
   * Get execution by ID
   */
  async getExecution(executionId: string): Promise<TaskExecution | null> {
    const dbExecution = await this.executions.get(executionId)
    return dbExecution ? deserializeExecution(dbExecution) : null
  }

  /**
   * Delete old executions
   */
  async cleanupOldExecutions(maxAgeDays: number): Promise<number> {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays)
    const cutoffStr = cutoffDate.toISOString()

    // Use indexed startedAt for efficient range query
    const oldIds = await this.executions.where("startedAt").below(cutoffStr).primaryKeys()

    if (oldIds.length > 0) {
      await this.executions.bulkDelete(oldIds)
    }

    return oldIds.length
  }

  /**
   * Boot reconciliation: flip orphaned `running` / `pending` executions to
   * `cancelled`. Their in-memory controllers (`runningByTask`,
   * `executionControllers`) live only for the process that started them, so a
   * reload or crash leaves the Dexie row stuck "running" forever — the missed-
   * task sweep reconciles *tasks*, never *executions*. Mirrors
   * `interruptBackgroundTasksOnBoot` for the scheduler's execution table.
   *
   * Returns the number of rows reconciled. Called once at scheduler startup.
   */
  async interruptStaleExecutions(now: Date = new Date()): Promise<number> {
    const nowIso = now.toISOString()
    const stale = await this.executions.where("status").anyOf("running", "pending").toArray()
    if (stale.length === 0) return 0
    const patched = stale.map((e) => ({
      ...e,
      status: "cancelled" as const,
      terminalReason: "interrupted-on-restart" as const,
      error: e.error ?? "Interrupted by app restart",
      completedAt: e.completedAt ?? nowIso,
    }))
    await this.executions.bulkPut(patched)
    return patched.length
  }

  // ========== Statistics ==========

  /**
   * Get task statistics — uses indexed counts to avoid loading all records into memory
   */
  async getStatistics(): Promise<TaskStatistics> {
    const now = new Date().toISOString()

    // Use indexed count queries instead of loading full arrays
    const [
      totalTasks,
      activeTaskCount,
      pausedTaskCount,
      totalExecutions,
      successfulCount,
      failedCount,
    ] = await Promise.all([
      this.tasks.count(),
      this.tasks.where("status").equals("active").count(),
      this.tasks.where("status").equals("paused").count(),
      this.executions.count(),
      this.executions.where("status").equals("completed").count(),
      this.executions.where("status").equals("failed").count(),
    ])

    // Count upcoming tasks using compound index
    const upcomingCount = await this.tasks
      .where("status")
      .equals("active")
      .filter((t) => t.nextRunAt !== undefined && t.nextRunAt > now)
      .count()

    // Calculate average duration — only load durations, not full records
    let averageDuration = 0
    let durationCount = 0
    let durationSum = 0
    await this.executions
      .where("status")
      .equals("completed")
      .each((e) => {
        if (e.duration !== undefined) {
          durationSum += e.duration
          durationCount++
        }
      })
    if (durationCount > 0) {
      averageDuration = Math.round(durationSum / durationCount)
    }

    return {
      totalTasks,
      activeTasks: activeTaskCount,
      pausedTasks: pausedTaskCount,
      totalExecutions,
      successfulExecutions: successfulCount,
      failedExecutions: failedCount,
      averageDuration,
      upcomingExecutions: upcomingCount,
    }
  }

  /**
   * Clear all data (for testing/reset)
   */
  async clearAll(): Promise<void> {
    await this.transaction("rw", [this.tasks, this.executions], () =>
      this.tasks
        .clear()
        .then(() => this.executions.clear())
        .then(() => undefined)
    )
  }
}

// ========== Serialization Helpers ==========

function serializeTask(task: ScheduledTask): DBScheduledTask {
  return {
    id: task.id,
    name: task.name,
    description: task.description,
    type: task.type,
    trigger: JSON.stringify({
      ...task.trigger,
      runAt: task.trigger.runAt?.toISOString(),
    }),
    eventType: task.trigger.type === "event" ? (task.trigger.eventType ?? "") : "",
    payload: task.payload !== undefined ? JSON.stringify(task.payload) : undefined,
    config: JSON.stringify(task.config),
    notification: JSON.stringify(task.notification),
    createdBy: JSON.stringify(task.createdBy ?? { kind: "user" }),
    // Denormalized so `[createdBySource+status]` can answer a per-source quota
    // without decrypting `createdBy` on every row. Defaults to "user" for the
    // same reason the blob above does.
    createdBySource: task.createdBy?.kind ?? "user",
    projectId: task.projectId,
    status: task.status,
    tags: task.tags ? JSON.stringify(task.tags) : undefined,
    endAt: task.endAt?.toISOString(),
    promotion: task.promotion
      ? JSON.stringify({ ...task.promotion, promotedAt: task.promotion.promotedAt.toISOString() })
      : undefined,
    onSuccessTaskIds: task.onSuccessTaskIds ? JSON.stringify(task.onSuccessTaskIds) : undefined,
    onFailureTaskIds: task.onFailureTaskIds ? JSON.stringify(task.onFailureTaskIds) : undefined,
    consecutiveFailures: task.consecutiveFailures,
    lastRunAt: task.lastRunAt?.toISOString(),
    nextRunAt: task.nextRunAt?.toISOString(),
    runCount: task.runCount,
    successCount: task.successCount,
    failureCount: task.failureCount,
    lastError: task.lastError,
    lastTerminalReason: task.lastTerminalReason,
    lastTerminalAt: task.lastTerminalAt?.toISOString(),
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  }
}

function deserializePromotion(serialized: string): ScheduledTask["promotion"] | undefined {
  try {
    const raw = JSON.parse(serialized) as {
      systemTaskId?: unknown
      token?: unknown
      promotedAt?: unknown
      backend?: unknown
    }
    if (typeof raw.systemTaskId !== "string" || typeof raw.token !== "string") return undefined
    const promotedAt = typeof raw.promotedAt === "string" ? new Date(raw.promotedAt) : new Date(0)
    return {
      systemTaskId: raw.systemTaskId,
      token: raw.token,
      promotedAt: Number.isNaN(promotedAt.getTime()) ? new Date(0) : promotedAt,
      backend: typeof raw.backend === "string" ? raw.backend : undefined,
    }
  } catch {
    return undefined
  }
}

/**
 * Recover the event discriminator from a stored trigger blob.
 *
 * Exported for `legacy-db-migration.ts`: rows drained out of the pre-v219
 * standalone database carry `eventType` already, but a row written by a very
 * old build may not, and a missing discriminator silently drops the task out
 * of every `[status+eventType]` lookup rather than erroring.
 */
export function eventTypeFromSerializedTrigger(serialized: string): string {
  try {
    const trigger = JSON.parse(serialized) as { type?: unknown; eventType?: unknown }
    return trigger.type === "event" && typeof trigger.eventType === "string"
      ? trigger.eventType
      : ""
  } catch {
    return ""
  }
}

/**
 * Recover the creator discriminator from a stored `createdBy` blob.
 *
 * Mirrors the default in `serializeTask`: a row with no creator record predates
 * the column and is necessarily user-authored, because no agent or plugin
 * creation surface existed before it.
 */
export function createdBySourceFromSerializedCreator(serialized: string | undefined): string {
  if (!serialized) return "user"
  try {
    const raw = JSON.parse(serialized) as { kind?: unknown }
    return typeof raw.kind === "string" ? raw.kind : "user"
  } catch {
    return "user"
  }
}

function deserializeTask(dbTask: DBScheduledTask): ScheduledTask {
  const trigger = JSON.parse(dbTask.trigger)
  const config = JSON.parse(dbTask.config) as ScheduledTask["config"]
  // Load-time migration: derive overlapPolicy from the legacy boolean for
  // tasks persisted before the policy field existed. Idempotent — an
  // explicit policy is never clobbered. Persists on the task's next update.
  if (config.overlapPolicy === undefined) {
    config.overlapPolicy = config.allowConcurrent ? "allow" : "skip"
  }
  return {
    id: dbTask.id,
    name: dbTask.name,
    description: dbTask.description,
    type: dbTask.type as ScheduledTask["type"],
    trigger: {
      ...trigger,
      runAt: trigger.runAt ? new Date(trigger.runAt) : undefined,
    },
    payload: dbTask.payload !== undefined ? JSON.parse(dbTask.payload) : undefined,
    config,
    notification: JSON.parse(dbTask.notification),
    createdBy: dbTask.createdBy ? JSON.parse(dbTask.createdBy) : { kind: "user" },
    projectId: dbTask.projectId,
    status: dbTask.status as ScheduledTask["status"],
    tags: dbTask.tags ? JSON.parse(dbTask.tags) : undefined,
    endAt: dbTask.endAt ? new Date(dbTask.endAt) : undefined,
    promotion: dbTask.promotion ? deserializePromotion(dbTask.promotion) : undefined,
    onSuccessTaskIds: dbTask.onSuccessTaskIds ? JSON.parse(dbTask.onSuccessTaskIds) : undefined,
    onFailureTaskIds: dbTask.onFailureTaskIds ? JSON.parse(dbTask.onFailureTaskIds) : undefined,
    consecutiveFailures: dbTask.consecutiveFailures,
    lastRunAt: dbTask.lastRunAt ? new Date(dbTask.lastRunAt) : undefined,
    nextRunAt: dbTask.nextRunAt ? new Date(dbTask.nextRunAt) : undefined,
    runCount: dbTask.runCount,
    successCount: dbTask.successCount,
    failureCount: dbTask.failureCount,
    lastError: dbTask.lastError,
    lastTerminalReason: dbTask.lastTerminalReason,
    lastTerminalAt: dbTask.lastTerminalAt ? new Date(dbTask.lastTerminalAt) : undefined,
    createdAt: new Date(dbTask.createdAt),
    updatedAt: new Date(dbTask.updatedAt),
  }
}

function safeDeserializeTask(dbTask: DBScheduledTask): ScheduledTask | null {
  try {
    return deserializeTask(dbTask)
  } catch (error) {
    log.warn(
      `Failed to deserialize task ${dbTask.id}: ${error instanceof Error ? error.message : String(error)}`
    )
    return null
  }
}

function serializeExecution(execution: TaskExecution): DBTaskExecution {
  return {
    id: execution.id,
    taskId: execution.taskId,
    taskName: execution.taskName,
    taskType: execution.taskType,
    status: execution.status,
    input: execution.input ? JSON.stringify(execution.input) : undefined,
    output: execution.output ? JSON.stringify(execution.output) : undefined,
    error: execution.error,
    retryAttempt: execution.retryAttempt,
    duration: execution.duration,
    scheduledFor: execution.scheduledFor?.toISOString(),
    triggerSource: execution.triggerSource,
    terminalReason: execution.terminalReason,
    retryScheduledAt: execution.retryScheduledAt?.toISOString(),
    startedAt: execution.startedAt.toISOString(),
    completedAt: execution.completedAt?.toISOString(),
    logs: JSON.stringify(
      execution.logs.map((log) => ({
        ...log,
        timestamp: log.timestamp.toISOString(),
      }))
    ),
  }
}

function deserializeExecution(dbExecution: DBTaskExecution): TaskExecution {
  const logs = JSON.parse(dbExecution.logs)
  return {
    id: dbExecution.id,
    taskId: dbExecution.taskId,
    taskName: dbExecution.taskName,
    taskType: dbExecution.taskType as TaskExecution["taskType"],
    status: dbExecution.status as TaskExecution["status"],
    input: dbExecution.input ? JSON.parse(dbExecution.input) : undefined,
    output: dbExecution.output ? JSON.parse(dbExecution.output) : undefined,
    error: dbExecution.error,
    retryAttempt: dbExecution.retryAttempt,
    duration: dbExecution.duration,
    scheduledFor: dbExecution.scheduledFor ? new Date(dbExecution.scheduledFor) : undefined,
    triggerSource: dbExecution.triggerSource as TaskExecution["triggerSource"],
    terminalReason: dbExecution.terminalReason,
    retryScheduledAt: dbExecution.retryScheduledAt
      ? new Date(dbExecution.retryScheduledAt)
      : undefined,
    startedAt: new Date(dbExecution.startedAt),
    completedAt: dbExecution.completedAt ? new Date(dbExecution.completedAt) : undefined,
    logs: logs.map((entry: Record<string, unknown>) => ({
      ...entry,
      timestamp: new Date(entry.timestamp as string),
    })),
  }
}

function safeDeserializeExecution(dbExecution: DBTaskExecution): TaskExecution | null {
  try {
    return deserializeExecution(dbExecution)
  } catch (error) {
    log.warn(
      `Failed to deserialize execution ${dbExecution.id}: ${error instanceof Error ? error.message : String(error)}`
    )
    return null
  }
}

/**
 * The one facade instance. Stateless, so a single module-level value is safe
 * even though the database underneath it is swapped on account switch.
 */
export const schedulerDb = new SchedulerDatabase()

export { SchedulerDatabase }
