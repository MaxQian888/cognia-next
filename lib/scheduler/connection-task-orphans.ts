/**
 * Orphan hygiene for connector-owned scheduled tasks (`connection:*`).
 *
 * Every `connection:*` task payload binds one adapter instance
 * (`{ adapterId }`): presence refresh, scheduled outbound, digests. The
 * executor for these types lives in the `integrations` boot bundle, which is
 * only mounted while the connector runtime itself is needed — so when the
 * bound adapter row is deleted, the persisted task keeps firing into
 * `EXECUTOR_NOT_FOUND` on every retry and every interval, forever.
 *
 * Two complementary sweeps, one verb:
 *
 *   - {@link deleteConnectionTasksForAdapter} — the adapter-removal cascade
 *     (`lib/connectors/adapter-residue.ts`): drops the schedule together with
 *     the rest of the adapter's residue, so the orphan is never created.
 *   - {@link reapOrphanedConnectionTasks} — the scheduler-boot sweep for rows
 *     orphaned before the cascade existed (or by a path that skipped it):
 *     any `connection:*` task whose `payload.adapterId` no longer resolves
 *     against `adapterInstances` can never execute again and is deleted.
 *
 * Deletion goes through the caller-supplied port — `TaskSchedulerImpl` when
 * the sweep runs inside the scheduler, `getTaskScheduler()` when a connector
 * path calls it — so in-memory timers and retries die with the row instead of
 * leaving a dangling schedule that still fires once.
 */

import type { ScheduledTask } from "@/types/scheduler"
import { getDb } from "@/lib/db/schema"
import { schedulerDb } from "./scheduler-db"

/**
 * The connector task namespace. `lib/scheduler/sources/run-mappers.ts` and
 * `CARD_AUTHORED_TASK_TYPES` already discriminate connector-owned types by
 * this prefix; a task type introduced later under it inherits this hygiene
 * automatically.
 */
export const CONNECTOR_TASK_TYPE_PREFIX = "connection:"
/** Distinguishes an adapter-disable pause from a user's explicit task pause. */
export const ADAPTER_DISABLED_PRESENCE_TAG = "usage-presence:paused-adapter-disabled"

/**
 * The scheduler surface the sweeps need. Implemented by `TaskSchedulerImpl`
 * (in-memory + durable delete) and by `getTaskScheduler()` for callers
 * outside the scheduler lifecycle.
 */
export interface ConnectionTaskDeletePort {
  deleteTask(taskId: string): Promise<unknown>
}

interface ConnectionTaskPausePort {
  pauseTask(taskId: string): Promise<unknown>
  updateTask(taskId: string, input: { status: "paused"; tags: string[] }): Promise<unknown>
}

/** Persist pause ownership together with status before retiring native timers. */
export async function pauseDisabledAdapterPresence(
  task: ScheduledTask,
  port: ConnectionTaskPausePort
): Promise<void> {
  if (task.status !== "active") return
  await port.updateTask(task.id, {
    status: "paused",
    tags: [...new Set([...(task.tags ?? []), ADAPTER_DISABLED_PRESENCE_TAG])],
  })
  await port.pauseTask(task.id)
}

/** Extract the bound adapter id from a task payload, when it carries one. */
export function connectionTaskAdapterId(task: ScheduledTask): string | undefined {
  const adapterId = (task.payload as Record<string, unknown> | undefined)?.adapterId
  return typeof adapterId === "string" && adapterId.length > 0 ? adapterId : undefined
}

async function listConnectionTasks(): Promise<ScheduledTask[]> {
  return schedulerDb.getTasksByTypePrefix(CONNECTOR_TASK_TYPE_PREFIX)
}

/**
 * Delete every `connection:*` scheduled task bound to `adapterId`. Used by
 * the adapter-removal cascade — the schedule is residue like the audit rows
 * and outbound queue the reaper already owns. Returns the deleted task ids.
 */
export async function deleteConnectionTasksForAdapter(
  adapterId: string,
  port: ConnectionTaskDeletePort
): Promise<string[]> {
  const tasks = await listConnectionTasks()
  const doomed = tasks.filter((task) => connectionTaskAdapterId(task) === adapterId)
  for (const task of doomed) {
    await port.deleteTask(task.id)
  }
  return doomed.map((task) => task.id)
}

/**
 * Is `adapterInstances` written here rather than synced down from a host?
 * The desktop shell owns its rows; Capacitor and a paired web client are
 * companion replicas; an unpaired browser keeps its own data.
 */
async function adapterRowsAreLocal(): Promise<boolean> {
  const { isCapacitor, isTauri } = await import("@/lib/platform/detect")
  if (isTauri()) return true
  if (isCapacitor()) return false
  const { hasWebCompanionTarget } = await import("@/lib/platform/web-companion")
  return !hasWebCompanionTarget()
}

/**
 * Delete every `connection:*` task whose bound adapter row no longer exists.
 * Run once per scheduler boot, BEFORE active tasks are armed — an orphan
 * armed here would only ever fail, since no bundle registers its executor
 * while no adapter is enabled.
 *
 * A missing row only proves removal where `adapterInstances` is written
 * locally. On a companion replica (Capacitor, a paired web client) the table
 * is filled by background-stage sync, so at boot a missing row may simply not
 * have arrived yet: there nothing is deleted, and disabled adapters are still
 * paused as usual.
 */
export async function reapOrphanedConnectionTasks(
  port: ConnectionTaskDeletePort & ConnectionTaskPausePort,
  options: { adapterRowsAreLocal?: () => boolean | Promise<boolean> } = {}
): Promise<string[]> {
  const tasks = await listConnectionTasks()
  const bound = new Map<string, ScheduledTask[]>()
  for (const task of tasks) {
    const adapterId = connectionTaskAdapterId(task)
    if (!adapterId) continue
    const list = bound.get(adapterId) ?? []
    list.push(task)
    bound.set(adapterId, list)
  }
  if (bound.size === 0) return []

  const boundIds = [...bound.keys()]
  const rows = await getDb().adapterInstances.bulkGet(boundIds)
  const rowsAreLocal = await (options.adapterRowsAreLocal ?? adapterRowsAreLocal)()
  const doomed: ScheduledTask[] = []
  for (const [index, row] of rows.entries()) {
    const tasks = bound.get(boundIds[index]) ?? []
    if (!row) {
      if (rowsAreLocal) doomed.push(...tasks)
    } else if (!row.enabled) {
      for (const task of tasks) {
        if (task.type === "connection:presence:refresh" && task.status === "active") {
          await pauseDisabledAdapterPresence(task, port)
        }
      }
    }
  }

  for (const task of doomed) {
    await port.deleteTask(task.id)
  }
  return doomed.map((task) => task.id)
}
