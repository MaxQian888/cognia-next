"use client"

/**
 * Main-window feed for the glance activity heatmap (ADR-0225 §2).
 *
 * Reads the usage ledger over its `at` index from the start of the chosen
 * range, never the whole table: a year of a busy install is a lot of rows,
 * and the 1M and 3M ranges should not pay for it. Inert while disabled.
 */

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import type { SessionUsageRow } from "@/lib/db/session-usage"
import { getDb } from "@/lib/db/schema"
import { activityRangeStart, buildActivitySlice } from "@/lib/glance/build-activity"
import type { GlanceActivitySlice } from "@/lib/glance/snapshot"
import type { GlanceActivityRange, GlanceUsageScope } from "@/types/glance/layout"

const EMPTY: SessionUsageRow[] = []

export function useGlanceActivity(
  enabled: boolean,
  range: GlanceActivityRange,
  scope: GlanceUsageScope,
  sessionFilter: ReadonlySet<string> | null,
  now: number
): GlanceActivitySlice | null {
  // Keyed by the range's first day, so the query is rebuilt at midnight and
  // when the range changes, not on every tick of `now`.
  const from = activityRangeStart(range, now)
  const rows = useLiveQuery<SessionUsageRow[], SessionUsageRow[]>(
    async () => (enabled ? getDb().sessionUsage.where("at").aboveOrEqual(from).toArray() : EMPTY),
    [enabled, from],
    EMPTY
  )
  return useMemo(
    () => (enabled ? buildActivitySlice({ rows, range, scope, sessionFilter, now }) : null),
    [enabled, rows, range, scope, sessionFilter, now]
  )
}
