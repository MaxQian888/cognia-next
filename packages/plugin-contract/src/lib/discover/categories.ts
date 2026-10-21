/**
 * The plugin contract's share of `lib/discover/categories.ts`, which re-exports these.
 */
import type { DISCOVER_VIEW_MODES } from "@/lib/discover/categories"

export type DiscoverViewMode = (typeof DISCOVER_VIEW_MODES)[number]
