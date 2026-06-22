/**
 * Plugin SDK — `view` capability surface.
 *
 * Re-exports view authoring helpers and the runtime registry for resolved tree
 * and React views mounted into plugin view containers.
 */

export { defineView, defineTreeDataProvider } from "../define/define-view"

export {
  registerView,
  unregisterViewsByPlugin,
  getViewSnapshot,
  listViewsForContainer,
  subscribeViews,
} from "@/lib/plugin/registries/tree-view-registry"

export type {
  PluginTreeNode,
  PluginViewDef,
  PluginViewProps,
  ResolvedPluginView,
  TreeDataProvider,
} from "@/types/plugin/plugin-view"
