/**
 * Plugin modules slice (ADR-0225 §6): the plugin modules a surface can offer,
 * and the published data of the ones it shows.
 *
 * The catalogue is filtered to the surface's platform, so a desktop-only
 * module is never offered on a phone. Titles arrive resolved: a plugin's i18n
 * bundle is loaded in the window that builds the snapshot, not in the tray
 * panel's webview or on a phone. Data is carried only for visible entries,
 * the rule every other slice follows (§7).
 */

import type { GlancePluginEntryId } from "@/types/glance/layout"

import { GLANCE_PLUGIN_LIMITS, type GlancePluginModuleEntry } from "./plugin-data"
import type { GlancePluginDataRecord } from "./plugin-registry"
import type { GlancePlatform } from "./registry"
import type { GlancePluginCatalogEntry, GlancePluginsSlice } from "./snapshot"

export interface BuildPluginsSliceInput {
  catalog: readonly GlancePluginModuleEntry[]
  dataOf: (id: GlancePluginEntryId) => GlancePluginDataRecord | null
  /** The plugin entries the surface shows. */
  visible: readonly GlancePluginEntryId[]
  platform: GlancePlatform
  /** The module's title in the user's language. */
  resolveTitle: (entry: GlancePluginModuleEntry) => string
  now: number
}

function capTitle(title: string, fallback: string): string {
  const text = title.replace(/\s+/g, " ").trim() || fallback
  return text.length > GLANCE_PLUGIN_LIMITS.title
    ? `${text.slice(0, GLANCE_PLUGIN_LIMITS.title - 1)}…`
    : text
}

export function buildPluginsSlice(input: BuildPluginsSliceInput): GlancePluginsSlice {
  const catalog: GlancePluginCatalogEntry[] = []
  const offered = new Set<GlancePluginEntryId>()
  for (const entry of input.catalog) {
    const platforms = entry.def.platforms ?? ["desktop", "mobile"]
    if (!platforms.includes(input.platform)) continue
    offered.add(entry.entryId)
    catalog.push({
      id: entry.entryId,
      pluginId: entry.pluginId,
      title: capTitle(input.resolveTitle(entry), entry.def.title),
      icon: entry.def.icon ?? null,
      sizes: [...(entry.def.sizes ?? ["compact", "standard"])],
      platforms: [...platforms],
    })
  }
  const modules: GlancePluginsSlice["modules"] = {}
  let updatedAt = 0
  for (const id of input.visible) {
    if (!offered.has(id)) continue
    const record = input.dataOf(id)
    if (!record) continue
    modules[id] = { updatedAt: record.updatedAt, data: record.data }
    if (record.updatedAt > updatedAt) updatedAt = record.updatedAt
  }
  return { updatedAt: updatedAt || input.now, catalog, modules }
}
