/**
 * Pure filter + summary helpers for the workflow run-history page. No React,
 * no Dexie — mirrors `lib/workflow/library-filter.ts` so the `RunList`
 * component stays a thin shell over testable logic.
 */

import type { RunStatus, WorkflowRunRow } from "@/types/workflow/visual"

/** Time window for the run-history date filter. */
export type RunTimeWindow = "all" | "24h" | "7d" | "30d"

export interface RunListFilters {
  /** Run status, or "all" to disable the status facet. */
  status: RunStatus | "all"
  /** Trigger node kind, or "all" to disable the trigger facet. */
  triggerKind: string | "all"
  /** Rolling time window measured back from `now`. */
  window: RunTimeWindow
  /** Free-text query matched against the run id and trigger kind. */
  query: string
}

export const DEFAULT_RUN_FILTERS: RunListFilters = {
  status: "all",
  triggerKind: "all",
  window: "all",
  query: "",
}

const DAY_MS = 24 * 60 * 60 * 1000

const WINDOW_MS: Record<Exclude<RunTimeWindow, "all">, number> = {
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
}

/** True when any facet would narrow the result set (drives the Clear button). */
export function isRunFilterActive(filters: RunListFilters): boolean {
  return (
    filters.status !== "all" ||
    filters.triggerKind !== "all" ||
    filters.window !== "all" ||
    filters.query.trim() !== ""
  )
}

/**
 * Apply the status / trigger / window / text facets. `now` is injected so the
 * function stays pure and testable (no `Date.now()` inside).
 */
export function filterRuns(
  runs: readonly WorkflowRunRow[],
  filters: RunListFilters,
  now: number
): WorkflowRunRow[] {
  const q = filters.query.trim().toLowerCase()
  const cutoff =
    filters.window === "all" ? Number.NEGATIVE_INFINITY : now - WINDOW_MS[filters.window]
  return runs.filter((run) => {
    if (filters.status !== "all" && run.status !== filters.status) return false
    if (filters.triggerKind !== "all" && run.triggerKind !== filters.triggerKind) return false
    if (run.startedAt < cutoff) return false
    if (q) {
      const hay = `${run.id} ${run.triggerKind}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
}

/** Distinct trigger kinds present in a run set, sorted, for the facet dropdown. */
export function distinctTriggerKinds(runs: readonly WorkflowRunRow[]): string[] {
  return Array.from(new Set(runs.map((r) => r.triggerKind))).sort()
}

export interface RunListSummary {
  total: number
  succeeded: number
  failed: number
  running: number
  /** Succeeded / total, or null when there are zero terminal-or-any runs. */
  successRate: number | null
  /** Mean wall-clock duration of completed runs, or null when none completed. */
  avgDurationMs: number | null
}

/**
 * Cheap roll-up over run rows only (no event reads): counts, success rate, and
 * average duration of completed runs.
 */
export function summarizeRuns(runs: readonly WorkflowRunRow[]): RunListSummary {
  let succeeded = 0
  let failed = 0
  let running = 0
  let durationSum = 0
  let completedCount = 0
  for (const run of runs) {
    if (run.status === "succeeded") succeeded += 1
    else if (run.status === "failed") failed += 1
    else if (run.status === "running") running += 1
    if (run.completedAt !== undefined) {
      durationSum += run.completedAt - run.startedAt
      completedCount += 1
    }
  }
  const total = runs.length
  return {
    total,
    succeeded,
    failed,
    running,
    successRate: total === 0 ? null : succeeded / total,
    avgDurationMs: completedCount === 0 ? null : durationSum / completedCount,
  }
}
