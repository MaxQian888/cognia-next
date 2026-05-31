/**
 * Pure search / filter / sort for the Goals History table (ADR-0019).
 *
 * Extracted as a free function so the table component stays declarative and
 * the matching logic is unit-testable without rendering. Operates over the
 * already-loaded `Goal[]` (the table holds them via `useLiveQuery`).
 */

import type { Goal, GoalStatus } from "@/types/goal"

export type GoalSortKey = "created" | "turns" | "tokens"
export type SortDir = "asc" | "desc"

export interface HistoryFilter {
  /** Case-insensitive substring match against `safeObjective`. */
  query?: string
  /** Status allow-list. Empty / undefined → all statuses. */
  statuses?: GoalStatus[]
  /** Sort column. Default `"created"`. */
  sort?: GoalSortKey
  /** Sort direction. Default `"desc"`. */
  dir?: SortDir
}

function sortValue(goal: Goal, key: GoalSortKey): number {
  switch (key) {
    case "turns":
      return goal.turnsUsed
    case "tokens":
      return goal.tokensUsed
    case "created":
      return goal.createdAt
  }
}

/**
 * Filter then sort a list of goals. Returns a new array; the input is never
 * mutated.
 */
export function filterAndSortGoals(goals: Goal[], filter: HistoryFilter = {}): Goal[] {
  const query = filter.query?.trim().toLowerCase() ?? ""
  const statuses = filter.statuses && filter.statuses.length > 0 ? new Set(filter.statuses) : null
  const sort = filter.sort ?? "created"
  const dir = filter.dir ?? "desc"

  const filtered = goals.filter((g) => {
    if (statuses && !statuses.has(g.status)) return false
    if (query && !g.safeObjective.toLowerCase().includes(query)) return false
    return true
  })

  const factor = dir === "asc" ? 1 : -1
  return filtered.sort((a, b) => {
    const delta = sortValue(a, sort) - sortValue(b, sort)
    // Stable tiebreak on createdAt so equal sort values keep a deterministic
    // order regardless of the source array's ordering.
    if (delta !== 0) return delta * factor
    return (a.createdAt - b.createdAt) * factor
  })
}
