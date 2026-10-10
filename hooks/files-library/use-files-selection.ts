"use client"

/**
 * Multi-select on the Files page (ADR-0223), on the shared file-manager
 * selection (`useRangeSelection`): click, Ctrl/⌘-click and Shift-click over the
 * items in view, in view order. Changing place or lens starts over, so a
 * selection never acts on items the person can no longer see.
 */

import { useEffect, useMemo } from "react"

import { useRangeSelection, type UseRangeSelectionResult } from "@/hooks/ui/use-range-selection"
import { serializeFilesSection } from "@/lib/files-library/deep-link"
import type { FilesEntry } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"

export interface FilesSelection extends UseRangeSelectionResult {
  /** Item keys in view, in order. */
  order: readonly string[]
  /** The selected entries, in view order. */
  entries: FilesEntry[]
}

export function useFilesSelection(visible: readonly FilesEntry[] | undefined): FilesSelection {
  const order = useMemo(() => (visible ?? []).map((entry) => entry.key), [visible])
  const range = useRangeSelection(order)
  const place = useFilesLibraryStore((s) => `${serializeFilesSection(s.section)}|${s.lens}`)
  const { clear } = range

  useEffect(() => {
    clear()
  }, [place, clear])

  const entries = useMemo(
    () => (visible ?? []).filter((entry) => range.selected.has(entry.key)),
    [visible, range.selected]
  )
  return { ...range, order, entries }
}
