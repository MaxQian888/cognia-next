/**
 * Turning a phone's layout into a demand, and a demand into something the
 * desktop's sources can build from (ADR-0225 §9).
 */

import { DEFAULT_GLANCE_PANEL_SETTINGS } from "@/lib/glance/presets"
import { GLANCE_MODULES } from "@/lib/glance/registry"
import {
  GLANCE_MODULE_IDS,
  isPluginEntryId,
  type GlanceLayoutEntry,
  type GlanceMobileSettings,
  type GlancePanelSettings,
} from "@/types/glance/layout"

import { isGlanceHostEntry, type GlanceHostEntryId, type GlanceRemoteDemand } from "./types"

/**
 * What a phone asks the desktop for: the host-sourced modules and plugin
 * entries among `needed` (what is on screen: the pinned modules on the home
 * screen, every visible one while the drawer is open), and the options they
 * are built with. `catalog` asks for the desktop's plugin catalogue while the
 * phone's editor is open. With no modules and no catalogue the phone holds no
 * lease at all.
 */
export function glanceDemandOf(
  settings: GlanceMobileSettings,
  needed: readonly GlanceLayoutEntry[],
  workspaceId: string | null,
  { catalog = false }: { catalog?: boolean } = {}
): GlanceRemoteDemand {
  const modules: GlanceHostEntryId[] = []
  for (const entry of needed) {
    if (!entry.hidden && isGlanceHostEntry(entry.id) && !modules.includes(entry.id)) {
      modules.push(entry.id)
    }
  }
  const scoped = settings.scope === "workspace" && workspaceId !== null
  return {
    modules,
    catalog,
    scope: scoped ? "workspace" : "all",
    workspaceId: scoped ? workspaceId : null,
    usage: { ...settings.options.usage },
    activity: { ...settings.options.activity },
  }
}

/**
 * The layout the desktop builds a phone's slices from. Only which modules are
 * on, the scope and the options matter to the sources; width, height and the
 * delegate bar are the tray panel's and keep their defaults.
 */
export function glanceConfigForDemand(demand: GlanceRemoteDemand): GlancePanelSettings {
  return {
    ...DEFAULT_GLANCE_PANEL_SETTINGS,
    preset: "custom",
    entries: [
      ...GLANCE_MODULE_IDS.map((id) => ({
        id,
        size: GLANCE_MODULES[id].sizes[0],
        hidden: !(demand.modules as readonly string[]).includes(id),
      })),
      // Plugin entries the phone shows: their data rides in the plugin slice.
      ...demand.modules.filter(isPluginEntryId).map((id) => ({
        id,
        size: "standard" as const,
        hidden: false,
      })),
    ],
    scope: demand.scope,
    options: { usage: { ...demand.usage }, activity: { ...demand.activity } },
  }
}
