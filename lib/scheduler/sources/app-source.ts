/**
 * App-source adapter: wraps the existing `scheduler-db` Dexie store +
 * `getTaskScheduler()` lifecycle into the unified source contract.
 *
 * This is the cognia-next "native" scheduler — chat / agent / skill /
 * external-agent / script / custom / plugin / backup tasks. No behavior
 * change vs the existing TaskScheduler; the adapter just normalizes the
 * row shape and routes CRUD to the same underlying APIs the UI already
 * uses today.
 */

import Dexie from "dexie"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import { getTaskScheduler } from "@/lib/scheduler/task-scheduler"
import type {
  CreateScheduledTaskInput,
  ScheduledTask,
  ScheduledTaskStatus,
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
   */
  observe?: (querier: () => Promise<ScheduledTask[]>) => RawObservable<ScheduledTask[]>
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

  return {
    kind,

    subscribe(observer: ScheduledItemSourceObserver): ScheduledItemSubscription {
      const sub = observe(() => db.getAllTasks()).subscribe({
        next: (tasks: ScheduledTask[]) => {
          observer.next(tasks.filter(ownsTask).map(toUnified))
        },
        error: (err: unknown) => observer.error?.(err),
      })
      return { unsubscribe: () => sub.unsubscribe() }
    },

    async list(): Promise<UnifiedScheduledItem[]> {
      const tasks = await db.getAllTasks()
      return tasks.filter(ownsTask).map(toUnified)
    },

    async listRuns(limit) {
      const ownsExecution = (taskType: string) => taskExecutionKind(taskType) === kind
      const executions = await (db.getRecentExecutionsMatching?.(ownsExecution, limit) ??
        schedulerDb.getRecentExecutionsMatching(ownsExecution, limit))
      const runs = executions.map(toUnifiedFromTaskExecution)
      return filterRunsByKind(runs, kind)
    },

    async get(sourceId: string): Promise<UnifiedScheduledItem | undefined> {
      const task = await db.getTask(sourceId)
      if (!task) return undefined
      if (!ownsTask(task)) return undefined
      return toUnified(task)
    },

    async create(input: CreateScheduledTaskInput): Promise<UnifiedScheduledItem> {
      const task = await scheduler.createTask(input)
      return toUnified(task)
    },

    async update(sourceId: string, input: UpdateScheduledTaskInput): Promise<void> {
      await scheduler.updateTask(sourceId, input)
    },

    async delete(sourceId: string): Promise<void> {
      await scheduler.deleteTask(sourceId)
    },

    async pause(sourceId: string): Promise<void> {
      await scheduler.pauseTask(sourceId)
    },

    async resume(sourceId: string): Promise<void> {
      await scheduler.resumeTask(sourceId)
    },

    async runNow(sourceId: string): Promise<void> {
      await scheduler.runTaskNow(sourceId)
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
