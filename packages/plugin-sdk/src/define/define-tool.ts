/**
 * Plugin SDK helper for manifest tool contributions.
 *
 * Pure typesafety pass-through for `manifest.tools[]` entries.
 */

import type { PluginToolDef } from "@cognia/plugin-contract/types/plugin/plugin"

export function defineTool(def: PluginToolDef): PluginToolDef {
  return def
}
