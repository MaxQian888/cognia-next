// Plugin-analytics table CRUD (Dexie v15 — §A-Schema).
//
// Lightweight counter store keyed on (pluginId, key). The Health and
// Analytics tabs read these rows to render "X invocations this week"
// without a separate event-log table.

import type { PluginAnalyticsRow } from "./plugin-types"
import { getDb } from "./schema"

export async function getAnalytic(
  pluginId: string,
  key: string
): Promise<PluginAnalyticsRow | undefined> {
  return getDb().pluginAnalytics.get([pluginId, key])
}

export async function listAnalyticsForPlugin(pluginId: string): Promise<PluginAnalyticsRow[]> {
  return getDb().pluginAnalytics.where("pluginId").equals(pluginId).toArray()
}

/**
 * Atomic counter bump. Reads the existing row, increments `count`, refreshes
 * `lastEventAt`, and writes back. Concurrent bumps within the same tick may
 * lose a count — acceptable for analytics and faster than a transaction
 * round-trip for every event.
 */
export async function incrementAnalytic(
  pluginId: string,
  key: string,
  by: number = 1
): Promise<PluginAnalyticsRow> {
  const existing = await getAnalytic(pluginId, key)
  const now = Date.now()
  const row: PluginAnalyticsRow = {
    pluginId,
    key,
    count: (existing?.count ?? 0) + by,
    lastEventAt: now,
  }
  await getDb().pluginAnalytics.put(row)
  return row
}

export async function setAnalytic(row: PluginAnalyticsRow): Promise<void> {
  await getDb().pluginAnalytics.put(row)
}

/** Drop every analytics row for the plugin. Called on uninstall. */
export async function clearAnalyticsForPlugin(pluginId: string): Promise<number> {
  const rows = await listAnalyticsForPlugin(pluginId)
  await Promise.all(rows.map((r) => getDb().pluginAnalytics.delete([r.pluginId, r.key])))
  return rows.length
}
