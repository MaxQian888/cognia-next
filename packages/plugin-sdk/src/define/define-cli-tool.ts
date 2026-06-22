/**
 * Plugin SDK helper for declarative CLI tool contributions.
 *
 * Pure typesafety pass-through for `manifest.cliTools[]` entries.
 */

import type { PluginCliToolDef } from "@/types/plugin/plugin-cli-tool"

export function defineCliTool(def: PluginCliToolDef): PluginCliToolDef {
  return def
}
