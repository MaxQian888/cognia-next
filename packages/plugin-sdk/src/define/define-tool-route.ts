/**
 * Plugin SDK helper for the `tool-route` capability.
 *
 * Pure typesafety pass-through for `manifest.toolRoutes[]` entries.
 */

import type { PluginToolRouteDef } from "@/types/plugin/plugin-tool-route"

export function defineToolRoute(def: PluginToolRouteDef): PluginToolRouteDef {
  return def
}
