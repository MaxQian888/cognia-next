/**
 * Plugin SDK helper for custom view containers (B1).
 *
 * Pure typesafety pass-through — wrapping a container in
 * `defineViewContainer()` gives plugin authors autocomplete and a compile-time
 * check that the shape matches `PluginViewContainerDef`.
 *
 * Usage:
 *   const explorer = defineViewContainer({
 *     id: "explorer",
 *     title: "Explorer",
 *     icon: "folder-tree",
 *   })
 */

import type { PluginViewContainerDef } from "@/types/plugin/plugin-view-container"

export function defineViewContainer(container: PluginViewContainerDef): PluginViewContainerDef {
  return container
}
