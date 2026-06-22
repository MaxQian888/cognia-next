/**
 * Plugin SDK helper for A2UI component contributions.
 *
 * Pure typesafety pass-through for `manifest.a2uiComponents[]` entries.
 */

import type { A2UIPluginComponentDef } from "@/types/plugin/plugin"

export function defineA2UIComponent(def: A2UIPluginComponentDef): A2UIPluginComponentDef {
  return def
}
