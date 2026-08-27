/**
 * App-source adapter: wraps the scheduler for the schedule the page currently
 * MANAGES into the unified source contract.
 *
 * This is the cognia-next "native" scheduler — chat / agent / skill /
 * external-agent / script / custom / plugin / backup tasks.
 *
 * ## Which host's tasks this emits (ADR-0128 §6)
 *
 * `SchedulerHostBar` lets the user pick whether this page reads and writes
 * *this device's* schedule or the *paired / remote host's*. That choice lives
 * in `scheduler-host-target.ts` and is resolved into a backend by
 * `getSchedulerDataSource()`. Every read and write below goes through it:
 *
 *   - `local`  → Dexie `liveQuery` over `scheduler-db` + `getTaskScheduler()`,
 *                exactly as before (push-based, no polling).
 *   - `paired` → the `scheduled_task_*` RPCs. There is no change feed across
 *                the companion transport, so `subscribe` polls at
 *                {@link REMOTE_TASK_POLL_INTERVAL_MS} and re-reads immediately
 *                after any write this source performs.
 *
 * The subscription re-attaches when the target flips
 * (`subscribeSchedulerHostTarget`), so switching hosts swaps the whole list
 * without a page reload. Before this, the sidebar / calendar / facet counts
 * always rendered the LOCAL rows while the detail pane, pause and run-now
 * (which go through the store) already followed the target — the two halves
 * of the page disagreed the moment a paired host was selected.
 *
 * The other four unified kinds (backup / workflow / system / connector) have
 * no cross-host RPC and are always this device's; `SchedulerHostBar` says so
 * while a paired schedule is being managed.
 */

import Dexie from "dexie"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import { getTaskScheduler } from "@/lib/scheduler/task-scheduler"
import {
  getSchedulerDataSource,
  type SchedulerDataSource,
} from "@/lib/scheduler/scheduler-data-source"
import { subscribeSchedulerHostTarget } from "@/lib/scheduler/scheduler-host-target"
import type {
  CreateScheduledTaskInput,
  ScheduledTask,
  ScheduledTaskStatus,
  TaskExecution,
  TaskExecutionTriggerSource,
  UpdateScheduledTaskInput,
} from "@/types/scheduler"
import {
  makeUnifiedId,
  type UnifiedScheduledItem,
  type UnifiedItemStatus,
} from "@/types/scheduler/unified"
import type {
  ScheduledItemSource,
  ScheduledItemSourceObserver,
  ScheduledItemSubscription,
} from "./types"
import { CONNECTOR_TASK_TYPE_PREFIX } from "./connector-source"
import { filterRunsByKind, taskExecutionKind, toUnifiedFromTaskExecution } from "./run-mappers"

/**
 * Tasks owned by the connector subsystem live in the same Dexie table as
 * app tasks but belong under the `connector` kind in the unified UI. Skip
 * them so they don't appear twice.
 */
function isAppOwnedTask(task: ScheduledTask): boolean {
  return task.type !== "plugin" && !task.type.startsWith(CONNECTOR_TASK_TYPE_PREFIX)
}

function isPluginOwnedTask(task: ScheduledTask): boolean {
  return task.type === "plugin"
}

/**
 * Minimal slice of `getTaskScheduler()` we depend on — narrows the surface so
 * tests can inject a mock without recreating the entire singleton. The real
 * scheduler matches this contract directly.
 */
export interface AppSourceScheduler {
  createTask(input: CreateScheduledTaskInput): Promise<ScheduledTask>
  updateTask(taskId: string, input: UpdateScheduledTaskInput): Promise<ScheduledTask | null>
  deleteTask(taskId: string): Promise<boolean>
  pauseTask(taskId: string): Promise<boolean>
  resumeTask(taskId: string): Promise<boolean>
  runTaskNow(
    taskId: string,
    opts?: { triggerSource?: TaskExecutionTriggerSource }
  ): Promise<unknown>
}

export interface AppSourceDb {
  getAllTasks(): Promise<ScheduledTask[]>
  getTask(taskId: string): Promise<ScheduledTask | null>
  getRecentExecutions?(limit: number): Promise<import("@/types/scheduler").TaskExecution[]>
  getRecentExecutionsMatching?(
    ownsTaskType: (taskType: string) => boolean,
    limit: number
  ): Promise<import("@/types/scheduler").TaskExecution[]>
}

export interface RawSourceObserver<T> {
  next(items: T): void
  error?(err: unknown): void
}

export interface RawSourceSubscription {
  unsubscribe(): void
}

export interface RawObservable<T> {
  subscribe(observer: RawSourceObserver<T>): RawSourceSubscription
}

export interface AppSourceDeps {
  scheduler?: AppSourceScheduler
  db?: AppSourceDb
  /**
   * Replace the live-subscription factory. In production this is `liveQuery`
   * from Dexie; tests pass a stub that yields whatever the test wants.
   *
   * Only used while the LOCAL schedule is managed — a paired host has no
   * change feed and is polled instead.
   */
  observe?: (querier: () => Promise<ScheduledTask[]>) => RawObservable<ScheduledTask[]>
  /**
   * Resolve the backend for the schedule the page manages. Defaults to
   * `getSchedulerDataSource()`; only its `host` discriminator and the remote
   * methods are used — the local path still goes through `scheduler` / `db`
   * above so injected test doubles keep working.
   */
  dataSource?: () => SchedulerDataSource
  /** Subscribe to host-target flips. Defaults to `subscribeSchedulerHostTarget`. */
  onHostTargetChange?: (listener: () => void) => () => void
  /** Poll cadence while a paired schedule is managed. */
  remotePollIntervalMs?: number
}

/**
 * How often the paired host's task list is re-read. The companion transport
 * has no change feed for `scheduled_task_*`, and every write this source
 * performs re-reads immediately, so this only has to catch changes made
 * elsewhere (the host's own fires, another client). Deliberately slower than
 * the run poll: a task row changes far less often than its executions.
 */
export const REMOTE_TASK_POLL_INTERVAL_MS = 30_000

/**
 * The reads + writes one unified task source needs, resolved per call against
 * whichever host the page currently manages.
 */
interface TaskSourceBackend {
  readonly host: "local" | "remote"
  listTasks(): Promise<ScheduledTask[]>
  getTask(taskId: string): Promise<ScheduledTask | null>
  listRuns(limit: number, ownsExecution: (taskType: string) => boolean): Promise<TaskExecution[]>
  createTask(input: CreateScheduledTaskInput): Promise<ScheduledTask>
  updateTask(taskId: string, input: UpdateScheduledTaskInput): Promise<unknown>
  deleteTask(taskId: string): Promise<unknown>
  pauseTask(taskId: string): Promise<unknown>
  resumeTask(taskId: string): Promise<unknown>
  runTaskNow(taskId: string): Promise<unknown>
}

function localBackend(scheduler: AppSourceScheduler, db: AppSourceDb): TaskSourceBackend {
  return {
    host: "local",
    listTasks: () => db.getAllTasks(),
    getTask: (taskId) => db.getTask(taskId),
    listRuns: (limit, ownsExecution) =>
      db.getRecentExecutionsMatching?.(ownsExecution, limit) ??
      schedulerDb.getRecentExecutionsMatching(ownsExecution, limit),
    createTask: (input) => scheduler.createTask(input),
    updateTask: (taskId, input) => scheduler.updateTask(taskId, input),
    deleteTask: (taskId) => scheduler.deleteTask(taskId),
    pauseTask: (taskId) => scheduler.pauseTask(taskId),
    resumeTask: (taskId) => scheduler.resumeTask(taskId),
    runTaskNow: (taskId) => scheduler.runTaskNow(taskId),
  }
}

function remoteBackend(source: SchedulerDataSource): TaskSourceBackend {
  return {
    host: "remote",
    listTasks: () => source.listTasks(),
    getTask: (taskId) => source.getTask(taskId),
    // The RPC has no "recent executions matching these task types" shape, so
    // the host returns the newest runs across every type and the kind split
    // happens here. Over-fetch so a busy `app` schedule cannot starve the
    // `plugin` list (and vice versa) out of one shared page.
    listRuns: async (limit, ownsExecution) => {
      const rows = await source.getRecentExecutions(Math.min(limit * 4, 200))
      return rows.filter((row) => ownsExecution(row.taskType)).slice(0, limit)
    },
    createTask: (input) => source.createTask(input),
    updateTask: (taskId, input) => source.updateTask(taskId, input),
    deleteTask: (taskId) => source.deleteTask(taskId),
    pauseTask: (taskId) => source.pauseTask(taskId),
    resumeTask: (taskId) => source.resumeTask(taskId),
    runTaskNow: (taskId) => source.runTaskNow(taskId, { triggerSource: "run-now" }),
  }
}

export function createAppSource(
  deps: AppSourceDeps = {}
): ScheduledItemSource<CreateScheduledTaskInput, UpdateScheduledTaskInput> {
  return createTaskSource("app", isAppOwnedTask, deps)
}

/** Real plugin tasks share SchedulerDB and the TaskScheduler lifecycle. */
export function createPluginTaskSource(
  deps: AppSourceDeps = {}
): ScheduledItemSource<CreateScheduledTaskInput, UpdateScheduledTaskInput> {
  return createTaskSource("plugin", isPluginOwnedTask, deps)
}

function createTaskSource(
  kind: "app" | "plugin",
  ownsTask: (task: ScheduledTask) => boolean,
  deps: AppSourceDeps
): ScheduledItemSource<CreateScheduledTaskInput, UpdateScheduledTaskInput> {
  const scheduler = deps.scheduler ?? getTaskScheduler()
  const db = deps.db ?? schedulerDb
  // `Dexie.liveQuery`, not a named `liveQuery` import: dexie's CJS build makes
  // `liveQuery` non-enumerable, so SWC's wildcard interop drops it the moment a
  // module also imports the `Dexie` default. See `lib/db/outbound-jobs.ts`.
  const observe = deps.observe ?? ((querier) => Dexie.liveQuery(querier))
  const resolveDataSource = deps.dataSource ?? getSchedulerDataSource
  const onHostTargetChange = deps.onHostTargetChange ?? subscribeSchedulerHostTarget
  const remotePollIntervalMs = deps.remotePollIntervalMs ?? REMOTE_TASK_POLL_INTERVAL_MS

  /**
   * Resolve the backend for the schedule currently managed. Re-resolved on
   * every call so a host switch takes effect without recreating the source
   * (the registry holds one instance for the process lifetime).
   */
  function backend(): TaskSourceBackend {
    const dataSource = resolveDataSource()
    return dataSource.host === "remote" ? remoteBackend(dataSource) : localBackend(scheduler, db)
  }

  /** Subscribers to nudge after a write, so a remote list does not sit stale
   * until the next poll. No-op while the local Dexie feed is driving. */
  const remoteRefreshers = new Set<() => void>()
  function afterWrite(): void {
    for (const refresh of remoteRefreshers) refresh()
  }

  return {
    kind,

    subscribe(observer: ScheduledItemSourceObserver): ScheduledItemSubscription {
      let disposed = false
      let detach: (() => void) | null = null

      const emit = (tasks: ScheduledTask[]) => {
        if (disposed) return
        observer.next(tasks.filter(ownsTask).map(toUnified))
      }
      const fail = (err: unknown) => {
        if (disposed) return
        observer.error?.(err)
      }

      const attach = () => {
        detach?.()
        detach = null
        if (disposed) return
        const active = backend()

        if (active.host === "local") {
          const sub = observe(() => active.listTasks()).subscribe({
            next: emit,
            error: fail,
          })
          detach = () => sub.unsubscribe()
          return
        }

        // Remote: poll, and re-read on demand after our own writes.
        const read = () => {
          void active.listTasks().then(emit).catch(fail)
        }
        read()
        const timer = setInterval(read, remotePollIntervalMs)
        remoteRefreshers.add(read)
        detach = () => {
          clearInterval(timer)
          remoteRefreshers.delete(read)
        }
      }

      attach()
      const offTargetChange = onHostTargetChange(attach)

      return {
        unsubscribe: () => {
          disposed = true
          offTargetChange()
          detach?.()
          detach = null
        },
      }
    },

    async list(): Promise<UnifiedScheduledItem[]> {
      const tasks = await backend().listTasks()
      return tasks.filter(ownsTask).map(toUnified)
    },

    async listRuns(limit) {
      const ownsExecution = (taskType: string) => taskExecutionKind(taskType) === kind
      const executions = await backend().listRuns(limit, ownsExecution)
      const runs = executions.map(toUnifiedFromTaskExecution)
      return filterRunsByKind(runs, kind)
    },

    async get(sourceId: string): Promise<UnifiedScheduledItem | undefined> {
      const task = await backend().getTask(sourceId)
      if (!task) return undefined
      if (!ownsTask(task)) return undefined
      return toUnified(task)
    },

    async create(input: CreateScheduledTaskInput): Promise<UnifiedScheduledItem> {
      const task = await backend().createTask(input)
      afterWrite()
      return toUnified(task)
    },

    async update(sourceId: string, input: UpdateScheduledTaskInput): Promise<void> {
      await backend().updateTask(sourceId, input)
      afterWrite()
    },

    async delete(sourceId: string): Promise<void> {
      await backend().deleteTask(sourceId)
      afterWrite()
    },

    async pause(sourceId: string): Promise<void> {
      await backend().pauseTask(sourceId)
      afterWrite()
    },

    async resume(sourceId: string): Promise<void> {
      await backend().resumeTask(sourceId)
      afterWrite()
    },

    async runNow(sourceId: string): Promise<void> {
      await backend().runTaskNow(sourceId)
      afterWrite()
    },
  }
}

/**
 * Map an internal `ScheduledTask` row to the unified shape. Exported so the
 * adapter test can assert on the conversion without a Dexie roundtrip.
 */
export function toUnified(task: ScheduledTask): UnifiedScheduledItem {
  const kind = task.type === "plugin" ? "plugin" : "app"
  return {
    unifiedId: makeUnifiedId(kind, task.id),
    kind,
    sourceId: task.id,
    name: task.name,
    description: task.description,
    status: mapAppStatus(task.status),
    triggerSummary: {
      type: task.trigger.type,
      cron: task.trigger.cronExpression,
      intervalMs: task.trigger.intervalMs,
      runAtMs: task.trigger.runAt ? task.trigger.runAt.getTime() : undefined,
      eventType: task.trigger.eventType,
      timezone: task.trigger.timezone,
    },
    nextRunAt: task.nextRunAt ? task.nextRunAt.getTime() : undefined,
    lastRunAt: task.lastRunAt ? task.lastRunAt.getTime() : undefined,
    successCount: task.successCount,
    failureCount: task.failureCount,
    tags: task.tags,
    projectId: task.projectId,
    origin: {
      tableName: "tasks",
      deepLinkHref: `/scheduler?taskId=${encodeURIComponent(task.id)}`,
    },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
  }
}

function mapAppStatus(status: ScheduledTaskStatus): UnifiedItemStatus {
  switch (status) {
    case "active":
    case "paused":
    case "disabled":
    case "expired":
      return status
    default:
      return "unknown"
  }
}
