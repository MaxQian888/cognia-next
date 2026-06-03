/**
 * Shared color palette for the Source Control graph + blame surfaces.
 *
 * Both the Commit Graph (lane coloring) and the Blame view (per-commit gutter
 * color) need a small set of visually distinct, theme-tracking colors. They
 * reuse the chart-1..5 categorical palette (`paletteColor`) so graph lanes and
 * blame stripes match the rest of the app's data viz and follow light/dark.
 *
 * Pure / render-agnostic: the graph layout algorithm emits a numeric color
 * INDEX (`lane % length`), and these helpers map an index — or a commit hash —
 * to a concrete resolved color, keeping the algorithm free of theme concerns.
 */

import { paletteColor } from "@/lib/observability/chart-palette"
import type { ThemeColors } from "@/hooks/logging/use-theme-colors"

/** Number of distinct lane colors before the palette repeats. */
export const GRAPH_PALETTE_LENGTH = 5

/**
 * Resolve the ordered lane palette from live theme colors. The Commit Graph
 * precomputes this once per render and indexes it by `GraphRow.color`.
 */
export function resolveGraphPalette(colors: ThemeColors): string[] {
  return Array.from({ length: GRAPH_PALETTE_LENGTH }, (_, i) => paletteColor(colors, i))
}

/**
 * Map an arbitrary commit hash to a stable color index in
 * `[0, length)` — used by Blame so each commit keeps a consistent stripe
 * color regardless of its position. Deterministic djb2 hash; same hash always
 * yields the same index.
 */
export function hashToColorIndex(hash: string, length = GRAPH_PALETTE_LENGTH): number {
  if (length <= 0) return 0
  let h = 5381
  for (let i = 0; i < hash.length; i++) {
    // h * 33 + c, kept in 32-bit range to stay deterministic across engines.
    h = ((h << 5) + h + hash.charCodeAt(i)) | 0
  }
  return ((h % length) + length) % length
}

/** Resolve a commit hash directly to its blame stripe color. */
export function colorForHash(colors: ThemeColors, hash: string): string {
  return paletteColor(colors, hashToColorIndex(hash))
}
