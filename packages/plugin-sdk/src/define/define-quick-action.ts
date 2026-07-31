/**
 * Plugin SDK helper for the `quick-action` capability.
 *
 * Pure typesafety pass-through — wrapping a manifest entry in
 * `defineQuickAction()` gives plugin authors autocomplete and a compile-time
 * check that the shape matches `PluginQuickActionDef`. Quick actions surface in
 * the command palette, composer menu, and tray; each must name a dispatch
 * target (`command` or `slash`).
 */

import type { PluginQuickActionDef } from "@/types/plugin"

export function defineQuickAction(def: PluginQuickActionDef): PluginQuickActionDef {
  return def
}
