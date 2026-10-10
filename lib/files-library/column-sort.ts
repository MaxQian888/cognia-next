/**
 * Clicking a Files list header (ADR-0223) cycles that column through its
 * natural direction, the reverse, and back to the view's own order. Dates and
 * sizes start newest/largest first; names, sources and types start A→Z.
 */

import type { FilesSort, FilesSortKey } from "./types"

const FIRST_DIRECTION: Record<FilesSortKey, FilesSort["dir"]> = {
  name: "asc",
  source: "asc",
  activity: "desc",
  size: "desc",
  type: "asc",
}

export function nextFilesSort(current: FilesSort | null, key: FilesSortKey): FilesSort | null {
  const first = FIRST_DIRECTION[key]
  if (!current || current.key !== key) return { key, dir: first }
  if (current.dir === first) return { key, dir: first === "asc" ? "desc" : "asc" }
  return null
}

export function ariaSortFor(
  current: FilesSort | null,
  key: FilesSortKey
): "ascending" | "descending" | "none" {
  if (!current || current.key !== key) return "none"
  return current.dir === "asc" ? "ascending" : "descending"
}
