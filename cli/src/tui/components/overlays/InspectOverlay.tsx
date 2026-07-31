/**
 * The `/inspect` overlay (default Ctrl+G): a picker of every tool/bash/subagent
 * cell that produced output, newest-first. Enter opens the chosen cell's full,
 * syntax-highlighted output in the document pager. A thin wrapper over the
 * shared {@link SelectList} primitive — it only formats {@link InspectItem}s into
 * list rows; navigation/selection are the parent's (reducer-driven) concern.
 */
import React from "react"

import { SelectList } from "../SelectList"
import type { InspectItem } from "../../state/types"

export function InspectOverlay({
  items,
  index,
  width,
  maxRows,
  query,
  onQueryChange,
  onMove,
  onSelect,
  onCancel,
}: {
  items: InspectItem[]
  index: number
  width?: number | string
  maxRows?: number
  /** Active typeahead filter (the parent owns filtering; this only renders 🔎). */
  query?: string
  /** Presence enables the search row; the parent re-filters on each keystroke. */
  onQueryChange?: (query: string) => void
  onMove: (delta: number) => void
  onSelect: (index: number) => void
  onCancel: () => void
}): React.ReactElement {
  const rows = items.map((it) => ({
    label: it.summary ? `${it.label}  ${it.summary}` : it.label,
    hint: it.lines > 0 ? `${it.lines} line${it.lines === 1 ? "" : "s"}` : undefined,
  }))
  return (
    <SelectList
      title="Inspect output"
      items={rows}
      index={index}
      width={width}
      maxRows={maxRows}
      query={query}
      searchPlaceholder="type to filter output"
      emptyHint="no output matches"
      onQueryChange={onQueryChange}
      onMove={onMove}
      onSelect={onSelect}
      onCancel={onCancel}
      footerHint="↑/↓ select · Enter view full output · Esc close"
    />
  )
}
