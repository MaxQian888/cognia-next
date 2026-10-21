/**
 * The plugin contract's share of `lib/plugin/registries/quick-action-registry.ts`, which re-exports these.
 */

import type { PluginQuickActionInput, PluginQuickActionSurface } from "../../../types/plugin/plugin"

export interface QuickActionEntry extends PluginQuickActionInput {
  /** Namespaced id: `<pluginId>:<localId>`. */
  fullId: string
  pluginId: string
  /** Id of the mirrored command-registry entry (dispatch handle). */
  commandId: string
  /** Resolved surfaces (defaults applied). */
  surfaces: PluginQuickActionSurface[]
}
