/**
 * Mid-run progress for a scheduled execution.
 *
 * The plugin task contract has always handed handlers a `reportProgress`
 * callback (`types/plugin/plugin-scheduler.ts` → `PluginTaskContext`), and the
 * notification layer has always had a `"progress"` event with its own title /
 * body and channel fan-out (`notification-integration.ts`). Neither end was
 * connected: `plugin-executor.ts` dropped every report into `log.debug` with
 * the comment "the scheduler doesn't record per-task progress yet", and
 * `TaskNotificationConfig.onProgress` was hard-coded `false` by both authoring
 * paths, so the branch could not be reached even by hand-editing a row.
 *
 * This module is the missing middle. A report:
 *
 *   1. becomes an `info` log entry on the execution (visible in the run sheet),
 *   2. is persisted, coalesced so a chatty reporter cannot hammer Dexie,
 *   3. raises the `progress` notification when the task opted in, rate-limited
 *      per execution so a long run cannot spam the notification center.
 *
 * Progress is advisory: a report never fails a run. Every persistence or
 * notification error is logged and swallowed.
 */

import { nanoid } from "nanoid"
import { loggers } from "@cognia/logging"
import type { ScheduledTask, TaskExecution, TaskExecutionLog } from "@/types/scheduler"
import { schedulerDb } from "./scheduler-db"
import { notifyTaskEvent } from "./notification-integration"

const log = loggers.scheduler

/** Marker on the log entry's `data`, so the UI can style progress rows. */
export const PROGRESS_LOG_KIND = "progress"

/**
 * Progress entries retained per execution. A handler that reports every row of
 * a 100k-row job must not grow the execution record without bound; the oldest
 * PROGRESS entries are dropped first and ordinary logs are never touched.
 */
export const MAX_PROGRESS_LOGS = 50

/** Minimum gap between two Dexie writes for the same execution. */
export const PROGRESS_PERSIST_INTERVAL_MS = 500

/**
 * Minimum gap between two `progress` notifications for the same execution.
 * A notification is a user-facing interruption; a run that reports every
 * second must not produce a notification every second.
 */
export const PROGRESS_NOTIFY_INTERVAL_MS = 30_000

interface ProgressState {
  lastPersistAt: number
  lastNotifyAt: number
  pendingPersist: ReturnType<typeof setTimeout> | null
}

const stateByExecution = new Map<string, ProgressState>()

function stateFor(executionId: string): ProgressState {
  let state = stateByExecution.get(executionId)
  if (!state) {
    state = { lastPersistAt: 0, lastNotifyAt: 0, pendingPersist: null }
    stateByExecution.set(executionId, state)
  }
  return state
}

/**
 * Clamp a reported fraction into `[0, 1]`. Handlers report percentages in the
 * wild (`50` for half done); anything above 1 is read as a percentage before
 * clamping, so both conventions land somewhere honest.
 */
export function normalizeProgressFraction(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  const fraction = value > 1 ? value / 100 : value
  return Math.min(1, Math.max(0, fraction))
}

/** Render the log line for a report. */
export function formatProgressMessage(
  fraction: number | undefined,
  message: string | undefined
): string {
  const percent = fraction === undefined ? null : `${Math.round(fraction * 100)}%`
  if (percent && message) return `${percent} — ${message}`
  if (percent) return percent
  return message ?? "in progress"
}

/**
 * Append the entry, evicting the oldest progress entries once the cap is hit.
 * Mutates `logs` in place because the scheduler owns the execution object and
 * persists whatever is on it at terminal time.
 */
export function appendProgressLog(logs: TaskExecutionLog[], entry: TaskExecutionLog): void {
  logs.push(entry)
  let overflow =
    logs.filter((row) => (row.data as { kind?: string } | undefined)?.kind === PROGRESS_LOG_KIND)
      .length - MAX_PROGRESS_LOGS
  if (overflow <= 0) return
  for (let index = 0; index < logs.length && overflow > 0; index += 1) {
    if ((logs[index].data as { kind?: string } | undefined)?.kind === PROGRESS_LOG_KIND) {
      logs.splice(index, 1)
      index -= 1
      overflow -= 1
    }
  }
}

export interface ReportTaskProgressDeps {
  now?: () => number
  persist?: (execution: TaskExecution) => Promise<void>
  notify?: (task: ScheduledTask, execution: TaskExecution) => Promise<void>
}

/**
 * Record one progress report against a running execution.
 *
 * Safe to call from any executor; today `plugin-executor.ts` is the only
 * producer because the plugin contract is the only one with a progress
 * callback. Nothing here is plugin-specific.
 */
export function reportTaskProgress(
  task: ScheduledTask,
  execution: TaskExecution,
  report: { progress?: number; message?: string },
  deps: ReportTaskProgressDeps = {}
): void {
  const now = deps.now ?? (() => Date.now())
  const persist = deps.persist ?? ((row: TaskExecution) => schedulerDb.updateExecution(row))
  const notify =
    deps.notify ??
    ((owner: ScheduledTask, row: TaskExecution) => notifyTaskEvent(owner, row, "progress"))

  const fraction = normalizeProgressFraction(report.progress)
  appendProgressLog(execution.logs, {
    id: nanoid(),
    timestamp: new Date(now()),
    level: "info",
    message: formatProgressMessage(fraction, report.message),
    data: { kind: PROGRESS_LOG_KIND, progress: fraction },
  })

  const state = stateFor(execution.id)
  const timestamp = now()

  // Coalesce writes: persist straight away when the last write is old enough,
  // otherwise schedule one trailing write so the newest state still lands.
  if (timestamp - state.lastPersistAt >= PROGRESS_PERSIST_INTERVAL_MS) {
    state.lastPersistAt = timestamp
    void persist(execution).catch((error: unknown) => {
      log.debug("Failed to persist task progress", { executionId: execution.id, error })
    })
  } else if (!state.pendingPersist) {
    state.pendingPersist = setTimeout(
      () => {
        state.pendingPersist = null
        state.lastPersistAt = now()
        void persist(execution).catch((error: unknown) => {
          log.debug("Failed to persist task progress", { executionId: execution.id, error })
        })
      },
      PROGRESS_PERSIST_INTERVAL_MS - (timestamp - state.lastPersistAt)
    )
  }

  if (!task.notification?.onProgress) return
  if (timestamp - state.lastNotifyAt < PROGRESS_NOTIFY_INTERVAL_MS) return
  state.lastNotifyAt = timestamp
  void notify(task, execution).catch((error: unknown) => {
    log.debug("Failed to raise progress notification", { executionId: execution.id, error })
  })
}

/**
 * Drop the rate-limit state for a finished execution. Called by the producer's
 * `finally` block; without it a long-lived process would keep one small record
 * per execution forever.
 */
export function forgetExecutionProgress(executionId: string): void {
  const state = stateByExecution.get(executionId)
  if (state?.pendingPersist) clearTimeout(state.pendingPersist)
  stateByExecution.delete(executionId)
}

/** Test seam — clears every rate-limit record. */
export function __resetExecutionProgressForTesting(): void {
  for (const state of stateByExecution.values()) {
    if (state.pendingPersist) clearTimeout(state.pendingPersist)
  }
  stateByExecution.clear()
}
