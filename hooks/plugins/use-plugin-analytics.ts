"use client"

// Reads `pluginAnalytics` rows from Dexie via a live query and groups them
// per plugin so the analytics tab can render counts + last-event timelines
// without re-fetching on every render.

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { getDb } from "@/lib/db/schema"
import type { PluginAnalyticsRow } from "@/lib/db/plugin-types"

export interface PluginAnalyticsByPlugin {
  pluginId: string
  /** Sum of all event counts attributed to this plugin. */
  totalEvents: number
  /** Most recent event timestamp across all keys. */
  lastEventAt: number
  /** Per-key counters for drill-down. */
  byKey: Record<string, { count: number; lastEventAt: number }>
}

export interface UsePluginAnalytics {
  rows: PluginAnalyticsRow[]
  byPlugin: PluginAnalyticsByPlugin[]
  /** True until the first useLiveQuery resolution. */
  loading: boolean
}

async function listAnalytics(): Promise<PluginAnalyticsRow[]> {
  return getDb().pluginAnalytics.orderBy("lastEventAt").reverse().toArray()
}

export function usePluginAnalytics(): UsePluginAnalytics {
  const rows = useLiveQuery(() => listAnalytics(), [])

  return useMemo(() => {
    const all = rows ?? []
    const grouped = new Map<string, PluginAnalyticsByPlugin>()

    for (const row of all) {
      let entry = grouped.get(row.pluginId)
      if (!entry) {
        entry = {
          pluginId: row.pluginId,
          totalEvents: 0,
          lastEventAt: 0,
          byKey: {},
        }
        grouped.set(row.pluginId, entry)
      }
      entry.totalEvents += row.count
      if (row.lastEventAt > entry.lastEventAt) entry.lastEventAt = row.lastEventAt
      entry.byKey[row.key] = { count: row.count, lastEventAt: row.lastEventAt }
    }

    return {
      rows: all,
      byPlugin: Array.from(grouped.values()).sort((a, b) => b.lastEventAt - a.lastEventAt),
      loading: rows === undefined,
    }
  }, [rows])
}
