// Custom view container contribution (B1 of the extension-point expansion).
//
// A view container is a plugin-owned destination in the left rail (like VS
// Code's `viewsContainers` / Obsidian's leaf side): the plugin contributes a
// rail icon → selecting it swaps the middle column to a plugin-owned panel
// that hosts the plugin's views (tree views / custom React panels / webviews,
// added in B2/B3). Declarative data only — no React factory here; the panel
// host reads the registry and renders the views registered for the container.

export interface PluginViewContainerDef {
  /** Stable id, namespaced to the plugin at registration (`<pluginId>:<id>`). */
  id: string
  /** Human-readable title shown in the rail tooltip + panel header. */
  title: string
  /**
   * Icon-name hint resolved by `lib/plugin/bridge/icons-bridge.ts` (a lucide
   * id or a registered plugin icon). Falls back to a generic puzzle glyph.
   */
  icon?: string
  /**
   * Where the container mounts. `rail` (default) adds a rail button that swaps
   * the middle column; `panel` registers the container without a rail button
   * (for containers a plugin opens programmatically / via a command).
   */
  location?: "rail" | "panel"
  /** Sort order among plugin rail buttons (ascending). Defaults to 0. */
  order?: number
  /**
   * Declarative `when` clause (context-key store) gating the rail button's
   * visibility — e.g. `"project.active"`. Absent = always shown.
   */
  when?: string
}
