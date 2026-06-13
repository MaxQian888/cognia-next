// Tree data providers + custom React views (B2 of the extension-point
// expansion). A plugin declares `manifest.views[]`; each view mounts into one
// of the plugin's view containers (B1) and is either a data-driven tree
// (VS Code `TreeDataProvider`) or an arbitrary React panel (Obsidian
// `registerView`). The view-bridge dynamic-imports the entry on enable and the
// container panel renders the resolved views.

import type React from "react"

/** One node in a plugin tree view. Children are resolved lazily via the provider. */
export interface PluginTreeNode {
  /** Stable id, unique within the view. Passed back to `getChildren`. */
  id: string
  /** Display label. */
  label: string
  /** Optional lucide icon name (PascalCase). */
  icon?: string
  /** Hint that this node has children (renders an expand chevron). */
  expandable?: boolean
  /** Initial collapsed state for an expandable node. Defaults to collapsed. */
  collapsed?: boolean
  /** Command id dispatched (via the unified command registry) when clicked. */
  command?: string
  /** Opaque value surfaced to context menus / when-clauses (future use). */
  contextValue?: string
}

/**
 * Supplies a tree view's nodes. `getChildren(undefined)` returns the roots;
 * `getChildren(nodeId)` returns a node's children. `onDidChangeTreeData`
 * notifies the host to refresh (return an unsubscribe).
 */
export interface TreeDataProvider {
  getChildren(parentId?: string): PluginTreeNode[] | Promise<PluginTreeNode[]>
  onDidChangeTreeData?(listener: () => void): () => void
}

/** Props passed to a `type: "react"` custom view component. */
export interface PluginViewProps {
  pluginId: string
  viewId: string
}

/**
 * Declarative view contribution (`manifest.views[]`). `entry`/`export` is a
 * lazy module reference: for `type: "tree"` the export is a `TreeDataProvider`
 * (or a zero-arg factory returning one); for `type: "react"` it is a React
 * component.
 */
export interface PluginViewDef {
  /** Stable id, namespaced to the plugin at registration (`<pluginId>:<id>`). */
  id: string
  /** Which view container (B1) this view mounts into — the container's local id. */
  containerId: string
  /** Optional section title shown above the view. */
  title?: string
  /** `tree` = data-driven tree; `react` = arbitrary panel component. */
  type: "tree" | "react"
  /** Relative module path (resolved against the plugin install root). */
  entry: string
  /** Named export inside `entry` (provider/factory or React component). */
  export: string
  /** Declarative `when` clause (context-key store) gating the view's visibility. */
  when?: string
}

/** A view resolved by the bridge — either a tree provider or a React component. */
export type ResolvedPluginView =
  | {
      kind: "tree"
      pluginId: string
      viewId: string
      containerId: string
      title?: string
      when?: string
      provider: TreeDataProvider
    }
  | {
      kind: "react"
      pluginId: string
      viewId: string
      containerId: string
      title?: string
      when?: string
      component: React.ComponentType<PluginViewProps>
    }
