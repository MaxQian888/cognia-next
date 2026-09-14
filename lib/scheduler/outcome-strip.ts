/**
 * Fourteen days of outcomes as fourteen cells (ADR-0179 §3).
 *
 * The recharts bar chart this replaces answered "how many runs on Tuesday"
 * with literal hex fills. The question the user asks is "did it work this
 * week", and a cell per day with one tone answers it at a glance. The same
 * buckets serve the whole schedule on the overview and one item in its
 * detail; the caller decides which runs to pass.
 */

import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

import { dayKey } from "./upcoming-occurrences"

export type OutcomeTone = "none" | "success" | "failure" | "mixed" | "running"

export interface OutcomeCell {
  /** Local `YYYY-MM-DD`. */
  key: string
  /** Local midnight of the day. */
  date: Date
  succeeded: number
  failed: number
  running: number
  /** Cancelled and skipped runs, counted but not toned. */
  other: number
  tone: OutcomeTone
}

export const OUTCOME_STRIP_DAYS = 14

const DAY_MS = 24 * 60 * 60 * 1000

function toneFor(cell: Pick<OutcomeCell, "succeeded" | "failed" | "running">): OutcomeTone {
  if (cell.running > 0 && cell.succeeded === 0 && cell.failed === 0) return "running"
  if (cell.failed > 0 && cell.succeeded > 0) return "mixed"
  if (cell.failed > 0) return "failure"
  if (cell.succeeded > 0) return "success"
  return "none"
}

/**
 * One cell per day ending today, oldest first. Runs outside the window are
 * ignored; runs are bucketed by the local day they started.
 */
export function buildOutcomeCells(
  runs: readonly UnifiedExecutionRun[],
  options: { now: number; days?: number }
): OutcomeCell[] {
  const days = options.days ?? OUTCOME_STRIP_DAYS
  const today = new Date(options.now)
  today.setHours(0, 0, 0, 0)
  const cells: OutcomeCell[] = []
  const byKey = new Map<string, OutcomeCell>()
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today.getTime() - offset * DAY_MS)
    const cell: OutcomeCell = {
      key: dayKey(date),
      date,
      succeeded: 0,
      failed: 0,
      running: 0,
      other: 0,
      tone: "none",
    }
    cells.push(cell)
    byKey.set(cell.key, cell)
  }
  for (const run of runs) {
    const cell = byKey.get(dayKey(new Date(run.startedAt)))
    if (!cell) continue
    switch (run.status) {
      case "succeeded":
        cell.succeeded += 1
        break
      case "failed":
        cell.failed += 1
        break
      case "running":
        cell.running += 1
        break
      default:
        cell.other += 1
    }
  }
  for (const cell of cells) cell.tone = toneFor(cell)
  return cells
}

/** Totals over the strip, for the caption beside it. */
export function summarizeOutcomeCells(cells: readonly OutcomeCell[]): {
  succeeded: number
  failed: number
  successRate: number | null
} {
  let succeeded = 0
  let failed = 0
  for (const cell of cells) {
    succeeded += cell.succeeded
    failed += cell.failed
  }
  const total = succeeded + failed
  return {
    succeeded,
    failed,
    successRate: total > 0 ? Math.round((succeeded / total) * 100) : null,
  }
}
