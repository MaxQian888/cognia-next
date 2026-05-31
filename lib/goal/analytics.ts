/**
 * Pure analytics layer for the Goals console (ADR-0019 — Analytics panel).
 *
 * Turns a flat `Goal[]` into the aggregates the Analytics tab renders: headline
 * counters (completion rate, averages, token spend), a status distribution for
 * the donut, and a day-bucketed timeline for the area / bar charts.
 *
 * Deliberately a pure function with an injectable `now` so it is fully
 * deterministic under test — no `Date.now()` reached from inside. The console
 * already holds every goal via `useLiveQuery(listAllGoals)`, so this runs over
 * in-memory data with zero extra DB round-trips.
 */

import type { Goal, GoalStatus } from "@/types/goal"
import { isTerminalGoalStatus } from "@/types/goal"

const DAY_MS = 24 * 60 * 60_000

/** Default look-back window for the timeline charts. */
export const DEFAULT_ANALYTICS_WINDOW_DAYS = 30

export interface GoalAnalyticsBucket {
  /** Local day key, "YYYY-MM-DD". */
  day: string
  /** ms timestamp of local midnight for the bucket (chart x-axis). */
  ts: number
  /** Goals created on this day. */
  created: number
  /** Tokens spent by goals created on this day. */
  tokens: number
}

export interface GoalStatusSlice {
  status: GoalStatus
  count: number
}

export interface GoalAnalytics {
  total: number
  active: number
  paused: number
  completed: number
  /** Goals in any terminal status. */
  terminal: number
  /** completed / terminal, 0..1. 0 when no terminal goals yet. */
  completionRate: number
  /** Mean turnsUsed across all goals. 0 when none. */
  avgTurns: number
  /** Mean tokensUsed across all goals. 0 when none. */
  avgTokens: number
  /** Cumulative tokensUsed across all goals. */
  totalTokens: number
  /** Fraction of goals that hit at least one judge parse failure. 0..1. */
  judgeFailureRate: number
  /** Non-zero status counts, ordered by the canonical status union. */
  statusDistribution: GoalStatusSlice[]
  /** Day buckets over the window, oldest → newest. */
  timeline: GoalAnalyticsBucket[]
}

const STATUS_ORDER: readonly GoalStatus[] = [
  "active",
  "paused",
  "completed",
  "stopped",
  "budget_limited",
  "turn_limited",
  "timed_out",
  "preempted",
]

/** Local-midnight day key, "YYYY-MM-DD". */
function dayKey(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

/** ms timestamp of local midnight for the given instant. */
function startOfDay(ts: number): number {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export interface ComputeAnalyticsOptions {
  /** Current instant (ms). Defaults to `Date.now()`. Injected for tests. */
  now?: number
  /** Timeline look-back window in days. Defaults to 30. */
  windowDays?: number
}

/**
 * Aggregate a list of goals into the dashboard analytics. Returns zeroed
 * aggregates (with an all-zero timeline) for an empty input so the panel can
 * still render its frame.
 */
export function computeGoalAnalytics(
  goals: Goal[],
  options: ComputeAnalyticsOptions = {}
): GoalAnalytics {
  const now = options.now ?? Date.now()
  const windowDays = Math.max(1, options.windowDays ?? DEFAULT_ANALYTICS_WINDOW_DAYS)

  const total = goals.length
  let active = 0
  let paused = 0
  let completed = 0
  let terminal = 0
  let turnsSum = 0
  let tokensSum = 0
  let judgeFailed = 0
  const statusCounts = new Map<GoalStatus, number>()

  for (const g of goals) {
    statusCounts.set(g.status, (statusCounts.get(g.status) ?? 0) + 1)
    if (g.status === "active") active++
    if (g.status === "paused") paused++
    if (g.status === "completed") completed++
    if (isTerminalGoalStatus(g.status)) terminal++
    turnsSum += g.turnsUsed
    tokensSum += g.tokensUsed
    if (g.judgeFailureCount > 0) judgeFailed++
  }

  // Build the day-bucketed timeline ending at today, going back windowDays.
  const todayStart = startOfDay(now)
  const buckets: GoalAnalyticsBucket[] = []
  const indexByDay = new Map<string, number>()
  for (let i = windowDays - 1; i >= 0; i--) {
    const ts = todayStart - i * DAY_MS
    const day = dayKey(ts)
    indexByDay.set(day, buckets.length)
    buckets.push({ day, ts, created: 0, tokens: 0 })
  }
  for (const g of goals) {
    const idx = indexByDay.get(dayKey(g.createdAt))
    if (idx === undefined) continue
    buckets[idx].created += 1
    buckets[idx].tokens += g.tokensUsed
  }

  const statusDistribution: GoalStatusSlice[] = STATUS_ORDER.filter(
    (s) => (statusCounts.get(s) ?? 0) > 0
  ).map((status) => ({ status, count: statusCounts.get(status) ?? 0 }))

  return {
    total,
    active,
    paused,
    completed,
    terminal,
    completionRate: terminal > 0 ? completed / terminal : 0,
    avgTurns: total > 0 ? turnsSum / total : 0,
    avgTokens: total > 0 ? tokensSum / total : 0,
    totalTokens: tokensSum,
    judgeFailureRate: total > 0 ? judgeFailed / total : 0,
    statusDistribution,
    timeline: buckets,
  }
}
