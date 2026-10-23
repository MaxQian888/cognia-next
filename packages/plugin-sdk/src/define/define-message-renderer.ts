/**
 * Plugin SDK helper for the `message-renderer` capability.
 *
 * Pure typesafety pass-through for `manifest.messageRenderers[]` entries.
 */

import type { PluginMessageRendererDef } from "@cognia/plugin-contract/types/plugin/plugin-message-renderer"

export function defineMessageRenderer(def: PluginMessageRendererDef): PluginMessageRendererDef {
  return def
}
