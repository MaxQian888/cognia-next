/**
 * Plugin SDK helper for LSP server contributions.
 *
 * Pure typesafety pass-through for `manifest.lspServers[]` entries.
 */

import type { PluginLspServerDef } from "@cognia/plugin-contract/types/plugin/plugin"

export function defineLspServer(def: PluginLspServerDef): PluginLspServerDef {
  return def
}
