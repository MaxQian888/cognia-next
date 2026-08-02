"use client"

/**
 * Live activity figures for the chat welcome dashboard.
 *
 * Reads the same `sessionUsage` table the Subscription → Usage tab reads,
 * through the same `useLiveQuery` subscription, and derives everything with the
 * same pure helpers (`filterByRange` → `collectActivityStats` /
 * `aggregateByDay` / `aggregateByModel`). Nothing is recomputed a second way:
 * the welcome page and the usage tab are two renderings of one aggregation.
 *
 * `now` is captured once per mount rather than read at every render, so the
 * trailing window, the streak, and the heatmap grid all agree on which day
 * "today" is for the lifetime of the panel — a mid-render clock change would
 * otherwise let the filtered rows and the painted cells disagree.
 */

import { useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { getDb } from "@/lib/db/schema"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import {
  aggregateByDay,
  aggregateByModel,
  filterByRange,
  type ModelUsageRow,
} from "@/lib/usage/session-analytics"
import {
  collectActivityStats,
  EMPTY_ACTIVITY_STATS,
  type ActivityStats,
} from "@/lib/usage/activity-stats"
import type { DailyUsage } from "@/types/system/usage"

export interface UseActivityStats {
  /** True until Dexie has delivered the first snapshot. */
  loading: boolean
  /** Headline figures over the trailing window. */
  stats: ActivityStats
  /** Sparse per-day aggregates for the heatmap (`fillDailyRange` pads them). */
  daily: DailyUsage[]
  /** Per-model breakdown, descending by cost. */
  models: ModelUsageRow[]
  /** Render-time "now" the window was cut at — pass it to the heatmap. */
  now: number
}

/**
 * @param rangeDays trailing local-calendar window (today counts as day one).
 */
export function useActivityStats(rangeDays: number): UseActivityStats {
  // Mount-stable clock: `useState` initializer runs once, so re-renders never
  // shift the window under the user.
  const [now] = useState(() => Date.now())

  const live = useLiveQuery(() => getDb().sessionUsage.toArray(), [])
  const rows: SessionUsageRow[] | undefined = live

  const inRange = useMemo(() => filterByRange(rows ?? [], rangeDays, now), [rows, rangeDays, now])

  const stats = useMemo(
    () => (rows ? collectActivityStats(inRange, { now }) : { ...EMPTY_ACTIVITY_STATS }),
    [rows, inRange, now]
  )
  const daily = useMemo(() => (rows ? aggregateByDay(inRange) : []), [rows, inRange])
  const models = useMemo(() => (rows ? aggregateByModel(inRange) : []), [rows, inRange])

  return { loading: rows === undefined, stats, daily, models, now }
}
