/**
 * Plugin SDK helper for the `tool-renderer` capability.
 *
 * Pure typesafety pass-through for `manifest.toolRenderers[]` entries.
 */

import type { PluginToolRendererDef } from "@/types/plugin/plugin-tool-renderer"

export function defineToolRenderer(def: PluginToolRendererDef): PluginToolRendererDef {
  return def
}
