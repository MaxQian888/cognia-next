/**
 * Plugin SDK helper for the `protocol-adapter` capability.
 *
 * Pure typesafety pass-through for `manifest.protocolAdapters[]` entries.
 */

import type { PluginProtocolAdapterDef } from "@cognia/plugin-contract/types/plugin/plugin-protocol-adapter"

export function defineProtocolAdapter(def: PluginProtocolAdapterDef): PluginProtocolAdapterDef {
  return def
}
