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
  grid: "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
  list: "flex flex-col gap-2",
  compact: "flex flex-col gap-1",
}

/** Resolve the container class for a view mode (defensive default → grid). */
export function discoverViewContainer(mode: DiscoverViewMode): string {
  return DISCOVER_VIEW_CONTAINER[mode] ?? DISCOVER_VIEW_CONTAINER.grid
}
