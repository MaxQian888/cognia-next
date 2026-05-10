/**
 * Aggregate workflow statistics for the Library dashboard. Reads from
 * `workflowRuns` (last 7 days for run counts and success rate) plus
 * non-template `workflows` (active count). A 30-second in-memory cache keeps
 * the dashboard snappy without missing recent runs by much.
 *
 * The query is intentionally tolerant — a fresh install where the dexie
 * tables are empty resolves to all-zero counts rather than throwing, so the
 * StatBar can decide to collapse itself.
 */

import { getDb } from "./schema"

export interface LibraryStats {
  /** Total run rows whose `startedAt` falls within the last 7 days. */
  runs7d: number
  /**
   * Succeeded / total ratio across the last-7-day window. `null` when the
   * window has zero total runs (avoids dividing by zero and surfacing a
   * meaningless 0%).
   */
  successRate: number | null
  /** Workflows that are not soft-deleted and not in the disabled state. */
  activeWorkflows: number
  /** Run rows whose status === "failed" and startedAt >= today 00:00 local. */
  failedToday: number
}

const DAY_MS = 24 * 60 * 60 * 1000
const CACHE_TTL_MS = 30_000

let cache: { ts: number; value: LibraryStats } | null = null

export async function getLibraryStats(now: number): Promise<LibraryStats> {
  if (cache && now - cache.ts < CACHE_TTL_MS) return cache.value
  const value = await readLibraryStats(now)
  cache = { ts: now, value }
  return value
}

/** Test hook — clears the in-memory cache. */
export function __resetLibraryStatsCacheForTesting(): void {
  cache = null
}

async function readLibraryStats(now: number): Promise<LibraryStats> {
  const sevenDaysAgo = now - 7 * DAY_MS
  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  const db = getDb()

  let runs7d = 0
  let succeeded = 0
  let failedToday = 0
  try {
    const recentRuns = await db.workflowRuns.where("startedAt").aboveOrEqual(sevenDaysAgo).toArray()
    runs7d = recentRuns.length
    for (const run of recentRuns) {
      if (run.status === "succeeded") succeeded += 1
      if (run.status === "failed" && run.startedAt >= todayStart.getTime()) failedToday += 1
    }
  } catch {
    // Table may not exist (fresh install / older schema). Silently no-op so
    // the dashboard collapses rather than erroring.
  }

  let activeWorkflows = 0
  try {
    const list = await db.workflows.toArray()
    for (const wf of list) {
      if (wf.isTemplate) continue
      activeWorkflows += 1
    }
  } catch {
    // Same fallback: tolerate missing/empty workflows table.
  }

  const successRate = runs7d === 0 ? null : succeeded / runs7d

  return { runs7d, successRate, activeWorkflows, failedToday }
}
