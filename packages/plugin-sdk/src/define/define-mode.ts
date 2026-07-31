/**
 * Plugin SDK helper for agent mode contributions.
 *
 * Pure typesafety pass-through for `manifest.modes[]` entries.
 */

import type { PluginModeDef } from "@/types/plugin/plugin"

export function defineMode(def: PluginModeDef): PluginModeDef {
  return def
}
