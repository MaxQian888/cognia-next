/**
 * Plugin SDK helpers for views (B2) — tree data providers + custom React
 * panels mounted into a view container.
 *
 * Pure typesafety pass-throughs: `defineView` for the manifest entry,
 * `defineTreeDataProvider` for a provider object so authors get autocomplete +
 * a compile-time shape check.
 *
 * Usage:
 *   // manifest entry
 *   const filesView = defineView({
 *     id: "files",
 *     containerId: "explorer",
 *     type: "tree",
 *     entry: "dist/views.js",
 *     export: "filesProvider",
 *   })
 *
 *   // the exported provider
 *   export const filesProvider = defineTreeDataProvider({
 *     getChildren: (parentId) => (parentId ? [] : [{ id: "a", label: "A" }]),
 *   })
 */

import type { PluginViewDef, TreeDataProvider } from "@/types/plugin/plugin-view"

export function defineView(view: PluginViewDef): PluginViewDef {
  return view
}

export function defineTreeDataProvider(provider: TreeDataProvider): TreeDataProvider {
  return provider
}
