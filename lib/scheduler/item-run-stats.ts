/**
 * The numbers one item's detail leads its outcomes with.
 *
 * The overview had a stat strip; an item had only the fourteen-cell strip,
 * which answers "did it work this week" but not "how often does it work",
 * "how long does it take" or "how did it end last time". An app-table row
 * carries lifetime counters the strip cannot show (it only sees the runs the
 * page fetched), so the lifetime totals come from the row when there is one
 * and from the runs otherwise; the duration and the last outcome always come
 * from the runs, because only they record them.
 */

import type { ScheduledTask } from "@/types/scheduler"
import type { UnifiedExecutionRun, UnifiedRunStatus } from "@/types/scheduler/unified-runs"

export interface ItemRunStats {
  /** Settled runs counted towards the rate (succeeded + failed). */
  total: number
  succeeded: number
  failed: number
  /** Whole-percent success rate, or `null` when nothing has settled yet. */
  successRate: number | null
  /** Mean duration of the settled runs that recorded one, or `null` when none did. */
  averageDurationMs: number | null
  /** Runs in flight right now. */
  running: number
  /** The most recent run, whatever its state. */
  lastRun: { status: UnifiedRunStatus; startedAt: number; durationMs?: number } | null
  /** Where `total` / `succeeded` / `failed` came from. */
  basis: "lifetime" | "loaded-runs"
}

function rate(succeeded: number, failed: number): number | null {
  const settled = succeeded + failed
  return settled === 0 ? null : Math.round((succeeded / settled) * 100)
}

export function summarizeItemRuns(
  runs: readonly UnifiedExecutionRun[],
  task?: Pick<ScheduledTask, "successCount" | "failureCount">
): ItemRunStats {
  let succeeded = 0
  let failed = 0
  let running = 0
  let durationTotal = 0
  let durationCount = 0
  let lastRun: ItemRunStats["lastRun"] = null

  for (const run of runs) {
    if (run.status === "succeeded") succeeded += 1
    else if (run.status === "failed") failed += 1
    else if (run.status === "running") running += 1
    if (
      (run.status === "succeeded" || run.status === "failed") &&
      typeof run.durationMs === "number" &&
      run.durationMs >= 0
    ) {
      durationTotal += run.durationMs
      durationCount += 1
    }
    if (!lastRun || run.startedAt > lastRun.startedAt) {
      lastRun = { status: run.status, startedAt: run.startedAt, durationMs: run.durationMs }
    }
  }

  const averageDurationMs = durationCount > 0 ? Math.round(durationTotal / durationCount) : null

  // The row's counters cover every run it ever made; the loaded runs are one
  // page of them. A row whose counters read zero while runs are on screen
  // predates the counters, so the runs are the better answer there.
  if (task && task.successCount + task.failureCount >= succeeded + failed) {
    return {
      total: task.successCount + task.failureCount,
      succeeded: task.successCount,
      failed: task.failureCount,
      successRate: rate(task.successCount, task.failureCount),
      averageDurationMs,
      running,
      lastRun,
      basis: "lifetime",
    }
  }

  return {
    total: succeeded + failed,
    succeeded,
    failed,
    successRate: rate(succeeded, failed),
    averageDurationMs,
    running,
    lastRun,
    basis: "loaded-runs",
  }
}
