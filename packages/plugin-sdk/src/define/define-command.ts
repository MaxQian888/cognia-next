/**
 * Plugin SDK helper for manifest command contributions.
 *
 * Pure typesafety pass-through for `manifest.commands[]` entries.
 */

import type { PluginManifestCommandDef } from "@/types/plugin/plugin"

export function defineCommand(def: PluginManifestCommandDef): PluginManifestCommandDef {
  return def
}
