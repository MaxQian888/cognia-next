/**
 * Connector-source adapter — surfaces the proactive-outbound subsystem
 * (`lib/connectors/scheduled-outbound.ts`) as unified scheduler items.
 *
 * The connector subsystem persists two flavours of scheduled work:
 *
 *   1. `connection:scheduled:digest` — periodic AI-driven digest tasks that
 *      live in the same scheduler-db `tasks` table as native app tasks. We
 *      surface each one as its own `connector` unified item so users can
 *      pause / resume / delete / run them from the scheduler page.
 *
 *   2. `connection:outbound:send` — one-shot outbound delivery tasks. There
 *      can be hundreds per day; surfacing each one as a unified row would
 *      flood the sidebar. Instead, we expose a single synthetic rollup row
 *      `connector:outbound:queue` whose metadata reads the outbound-queue
 *      Dexie table's live `count()` and the recent `connectorAudit` rows.
 *
 * The `app-source.ts` adapter excludes rows whose `type` starts with
 * `CONNECTOR_TASK_TYPE_PREFIX` so connector jobs are not double-listed
 * under both "app" and "connector".
 *
 * Capabilities:
 *   - digest items: read + pause + resume + delete + runNow + edit (via
 *     the underlying scheduler-db CRUD, same as app-source)
 *   - outbound rollup: read-only (no actions surfaced). Manipulating the
 *     runner master switch from the scheduler page is out of scope for
 *     this pass — operators can still inspect queue length + recent
 *     delivery audit through the detail view.
 */

import Dexie from "dexie"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import { getTaskScheduler } from "@/lib/scheduler/task-scheduler"
import { getDb } from "@/lib/db/schema"
import type {
  ScheduledTask,
  ScheduledTaskStatus,
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
import { filterRunsByKind, toUnifiedFromAudit, toUnifiedFromTaskExecution } from "./run-mappers"

/**
 * Task-type prefix that distinguishes connector-owned scheduler rows from
 * generic app tasks. Exported so `app-source.ts` can apply the inverse
 * filter without duplicating the constant.
 */
export const CONNECTOR_TASK_TYPE_PREFIX = "connection:"

/** Task type identifying a periodic digest job. */
export const CONNECTOR_DIGEST_TYPE = "connection:scheduled:digest"

/**
 * Stable sourceId of the synthetic outbound-queue rollup. The unifiedId
 * is `connector:outbound:queue`.
 */
export const CONNECTOR_QUEUE_SOURCE_ID = "outbound:queue"

export interface ConnectorSourceScheduler {
  updateTask(taskId: string, input: UpdateScheduledTaskInput): Promise<ScheduledTask | null>
  deleteTask(taskId: string): Promise<boolean>
  pauseTask(taskId: string): Promise<boolean>
  resumeTask(taskId: string): Promise<boolean>
  runTaskNow(taskId: string): Promise<unknown>
}

export interface ConnectorSourceDb {
  getAllTasks(): Promise<ScheduledTask[]>
  getTask(taskId: string): Promise<ScheduledTask | null>
  getRecentExecutions?(limit: number): Promise<import("@/types/scheduler").TaskExecution[]>
  getRecentExecutionsMatching?(
    ownsTaskType: (taskType: string) => boolean,
    limit: number
  ): Promise<import("@/types/scheduler").TaskExecution[]>
}

export interface OutboundQueueProbe {
  /** Resolves to the current pending outbound count. */
  count(): Promise<number>
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

export interface ConnectorSourceDeps {
  scheduler?: ConnectorSourceScheduler
  db?: ConnectorSourceDb
  /**
   * Probe for the outbound-queue table. Default reads
   * `getDb().outboundQueue.count()`. Tests inject a stub.
   */
  outboundQueueProbe?: OutboundQueueProbe
  /**
   * Replace the live-subscription factory. Default is `liveQuery` (Dexie).
   */
  observe?: (querier: () => Promise<ScheduledTask[]>) => RawObservable<ScheduledTask[]>
  /**
   * Replace the queue-count live observer. Default polls
   * `outboundQueueProbe.count()` via `liveQuery`.
   */
  observeQueueCount?: (querier: () => Promise<number>) => RawObservable<number>
  listAuditRuns?: (limit: number) => Promise<import("@/lib/db/connector-types").ConnectorAuditRow[]>
}

export function createConnectorSource(
  deps: ConnectorSourceDeps = {}
): ScheduledItemSource<never, UpdateScheduledTaskInput> {
  const scheduler = deps.scheduler ?? getTaskScheduler()
  const db = deps.db ?? schedulerDb
  const queueProbe: OutboundQueueProbe = deps.outboundQueueProbe ?? {
    count: () => getDb().outboundQueue.count(),
  }
  // `Dexie.liveQuery`, not a named `liveQuery` import: dexie's CJS build makes
  // `liveQuery` non-enumerable, so SWC's wildcard interop drops it the moment a
  // module also imports the `Dexie` default. See `lib/db/outbound-jobs.ts`.
  const observe = deps.observe ?? ((querier) => Dexie.liveQuery(querier))
  const observeQueueCount = deps.observeQueueCount ?? ((querier) => Dexie.liveQuery(querier))
  const listAuditRuns =
    deps.listAuditRuns ??
    ((limit: number) => getDb().connectorAudit.orderBy("at").reverse().limit(limit).toArray())

  /**
   * Compose the unified list: connector digest items + the queue rollup row.
   * Tasks whose `type` doesn't start with `connection:` are ignored (they
   * belong to the app source).
   */
  async function buildItems(): Promise<UnifiedScheduledItem[]> {
    const [allTasks, queueLength] = await Promise.all([
      db.getAllTasks(),
      queueProbe.count().catch(() => 0),
    ])
    const digests = allTasks
      .filter((t) => t.type.startsWith(CONNECTOR_TASK_TYPE_PREFIX))
      .map((t) => toUnifiedConnectorDigest(t))
    return [...digests, toUnifiedOutboundQueue(queueLength)]
  }

  return {
    kind: "connector",

    subscribe(observer: ScheduledItemSourceObserver): ScheduledItemSubscription {
      // Two live observables: tasks (for digests) + queue count (for rollup).
      // Push whichever fires; combined emit reuses `buildItems` so the snapshot
      // stays consistent.
      let latestTasks: ScheduledTask[] = []
      let latestQueueLen = 0
      const emit = (): void => {
        const digests = latestTasks
          .filter((t) => t.type.startsWith(CONNECTOR_TASK_TYPE_PREFIX))
          .map((t) => toUnifiedConnectorDigest(t))
        observer.next([...digests, toUnifiedOutboundQueue(latestQueueLen)])
      }

      const taskSub = observe(() => db.getAllTasks()).subscribe({
        next: (tasks: ScheduledTask[]) => {
          latestTasks = tasks
          emit()
        },
        error: (err: unknown) => observer.error?.(err),
      })
      const queueSub = observeQueueCount(() => queueProbe.count()).subscribe({
        next: (count: number) => {
          latestQueueLen = typeof count === "number" ? count : 0
          emit()
        },
        error: (err: unknown) => observer.error?.(err),
      })

      return {
        unsubscribe: () => {
          taskSub.unsubscribe()
          queueSub.unsubscribe()
        },
      }
    },

    async list(): Promise<UnifiedScheduledItem[]> {
      return buildItems()
    },

    async listRuns(limit) {
      const [executions, auditRows] = await Promise.all([
        db.getRecentExecutionsMatching?.(
          (taskType) => taskType.startsWith(CONNECTOR_TASK_TYPE_PREFIX),
          limit
        ) ??
          schedulerDb.getRecentExecutionsMatching(
            (taskType) => taskType.startsWith(CONNECTOR_TASK_TYPE_PREFIX),
            limit
          ),
        listAuditRuns(limit),
      ])
      return [
        ...filterRunsByKind(executions.map(toUnifiedFromTaskExecution), "connector"),
        ...auditRows.map(toUnifiedFromAudit),
      ]
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, limit)
    },

    async get(sourceId: string): Promise<UnifiedScheduledItem | undefined> {
      if (sourceId === CONNECTOR_QUEUE_SOURCE_ID) {
        const queueLength = await queueProbe.count().catch(() => 0)
        return toUnifiedOutboundQueue(queueLength)
      }
      const task = await db.getTask(sourceId)
      if (!task) return undefined
      if (!task.type.startsWith(CONNECTOR_TASK_TYPE_PREFIX)) return undefined
      return toUnifiedConnectorDigest(task)
    },

    create(): Promise<UnifiedScheduledItem> {
      return Promise.reject(
        new Error(
          "Connector job creation is not supported here — schedule a digest from the conversation override settings."
        )
      )
    },

    async update(sourceId: string, input: UpdateScheduledTaskInput): Promise<void> {
      if (sourceId === CONNECTOR_QUEUE_SOURCE_ID) return
      await scheduler.updateTask(sourceId, input)
    },

    async delete(sourceId: string): Promise<void> {
      if (sourceId === CONNECTOR_QUEUE_SOURCE_ID) return
      await scheduler.deleteTask(sourceId)
    },

    async pause(sourceId: string): Promise<void> {
      if (sourceId === CONNECTOR_QUEUE_SOURCE_ID) return
      await scheduler.pauseTask(sourceId)
    },

    async resume(sourceId: string): Promise<void> {
      if (sourceId === CONNECTOR_QUEUE_SOURCE_ID) return
      await scheduler.resumeTask(sourceId)
    },

    async runNow(sourceId: string): Promise<void> {
      if (sourceId === CONNECTOR_QUEUE_SOURCE_ID) return
      await scheduler.runTaskNow(sourceId)
    },
  }
}

/**
 * Map a `connection:scheduled:digest` (or any `connection:*`) row to the
 * unified shape. Exported so tests can assert on the mapping without a
 * Dexie roundtrip.
 */
export function toUnifiedConnectorDigest(task: ScheduledTask): UnifiedScheduledItem {
  return {
    unifiedId: makeUnifiedId("connector", task.id),
    kind: "connector",
    sourceId: task.id,
    name: task.name,
    description: task.description ?? task.type,
    status: mapConnectorStatus(task.status),
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

/**
 * Build the synthetic outbound-queue rollup row. The displayed name embeds
 * the live queue length so the sidebar surface communicates pressure at a
 * glance.
 */
export function toUnifiedOutboundQueue(queueLength: number): UnifiedScheduledItem {
  return {
    unifiedId: makeUnifiedId("connector", CONNECTOR_QUEUE_SOURCE_ID),
    kind: "connector",
    sourceId: CONNECTOR_QUEUE_SOURCE_ID,
    name: `Outbound queue (${queueLength})`,
    description: "Connector outbound delivery queue",
    status: queueLength > 0 ? "active" : "unknown",
    triggerSummary: { type: "event", eventType: "outbound.queue" },
    origin: {
      tableName: "outboundQueue",
      deepLinkHref: "/settings?section=connections&connTab=outbound",
    },
    capabilities: { runNow: false, pause: false, edit: false, delete: false },
  }
}

function mapConnectorStatus(status: ScheduledTaskStatus): UnifiedItemStatus {
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
