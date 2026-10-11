/**
 * Activity slice: a per-day heatmap over the usage ledger (ADR-0225 §2).
 *
 * Streaks, active days and the peak hour come from the welcome dashboard's own
 * `collectActivityStats`, so the panel and the welcome page cannot disagree
 * about the same window. Daily tokens use the usage glance's definition (fresh
 * input + output), the same number the usage module beside it shows.
 */

import type { SessionUsageRow } from "@/lib/db/session-usage"
import { collectActivityStats } from "@/lib/usage/activity-stats"
import { localDay } from "@/lib/usage/session-analytics"
import { rowInScope } from "@/lib/usage/usage-glance"
import type { GlanceActivityRange, GlanceUsageScope } from "@/types/glance/layout"

import { lastLocalDays } from "./build-usage"
import type { GlanceActivityDay, GlanceActivitySlice } from "./snapshot"

/** Days covered by each range, today included. */
export const GLANCE_ACTIVITY_DAYS: Readonly<Record<GlanceActivityRange, number>> = {
  "1m": 35,
  "3m": 91,
  "1y": 371,
}

/** Epoch ms of local midnight at the start of a range. */
export function activityRangeStart(range: GlanceActivityRange, now: number): number {
  const today = new Date(now)
  return new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - (GLANCE_ACTIVITY_DAYS[range] - 1)
  ).getTime()
}

/**
 * Level 1-4 by quartile of the ACTIVE days in range, so one huge day does not
 * flatten every other day to level 1. Inactive days are 0.
 */
function levelsOf(tokens: readonly number[]): Array<0 | 1 | 2 | 3 | 4> {
  const active = tokens.filter((t) => t > 0).sort((a, b) => a - b)
  if (active.length === 0) return tokens.map(() => 0)
  // The value at the END of each quarter, so with four active days each lands
  // on its own level and the top day always reaches 4.
  const q = (p: number) => active[Math.max(0, Math.ceil(p * active.length) - 1)]
  const [q1, q2, q3] = [q(0.25), q(0.5), q(0.75)]
  return tokens.map((t) => {
    if (t <= 0) return 0
    if (t <= q1) return 1
    if (t <= q2) return 2
    if (t <= q3) return 3
    return 4
  })
}

export interface BuildActivitySliceInput {
  rows: readonly SessionUsageRow[]
  range: GlanceActivityRange
  scope: GlanceUsageScope
  /** When set, only these sessions count (the workspace filter). */
  sessionFilter: ReadonlySet<string> | null
  now: number
}

export function buildActivitySlice(input: BuildActivitySliceInput): GlanceActivitySlice {
  const from = activityRangeStart(input.range, input.now)
  const glanceScope = input.scope === "all-tools" ? "all-tools" : "cognia"
  const rows = input.rows.filter(
    (row) =>
      row.at >= from &&
      row.at <= input.now + 300_000 &&
      rowInScope(row, glanceScope) &&
      (!input.sessionFilter || input.sessionFilter.has(row.sessionId))
  )

  const perDay = new Map<string, number>()
  for (const row of rows) {
    const day = localDay(row.at)
    perDay.set(day, (perDay.get(day) ?? 0) + (row.inputTokens ?? 0) + (row.outputTokens ?? 0))
  }
  const keys = lastLocalDays(input.now, GLANCE_ACTIVITY_DAYS[input.range])
  const tokens = keys.map((day) => perDay.get(day) ?? 0)
  const levels = levelsOf(tokens)
  const days: GlanceActivityDay[] = keys.map((day, i) => ({
    day,
    tokens: tokens[i],
    level: levels[i],
  }))

  const stats = collectActivityStats(rows, { now: input.now })
  return {
    updatedAt: input.now,
    range: input.range,
    days,
    activeDays: stats.activeDays,
    currentStreak: stats.currentStreak,
    longestStreak: stats.longestStreak,
    peakHour: stats.peakHour,
  }
}
