/**
 * Container layout classes for the three Discover view modes, shared by the
 * desktop/mobile `<DiscoverGrid />` and the mobile legacy card lists
 * (characters / teams / skills) so density stays consistent across surfaces.
 *
 * Deliberately padding-free — each call site owns its own padding (the grid
 * adds `p-4`; the mobile legacy lists sit inside an already-padded scroll area).
 */

import type { DiscoverViewMode } from "@/lib/discover/categories"

export const DISCOVER_VIEW_CONTAINER: Record<DiscoverViewMode, string> = {
  // Column count tracks the grid's OWN width (`@container/discover-grid`,
  // established by the call site's wrapper), NOT the viewport. The grid renders
  // inside the `FeaturePageShell` center pane and the mobile scroll area, so
  // viewport breakpoints would pack 3–4 columns into a narrow pane and overlap
  // the cards. Mirrors `components/plugins/plugin-panel-grid.tsx`.
  grid: "grid grid-cols-1 gap-3 @md/discover-grid:grid-cols-2 @4xl/discover-grid:grid-cols-3 @6xl/discover-grid:grid-cols-4",
  list: "flex flex-col gap-2",
  compact: "flex flex-col gap-1",
}

/** Resolve the container class for a view mode (defensive default → grid). */
export function discoverViewContainer(mode: DiscoverViewMode): string {
  return DISCOVER_VIEW_CONTAINER[mode] ?? DISCOVER_VIEW_CONTAINER.grid
}
