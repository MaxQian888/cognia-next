/**
 * The `/inspect` overlay (default Ctrl+G): a picker of every tool/bash/subagent
 * cell that produced output, newest-first. Enter opens the chosen cell's full,
 * syntax-highlighted output in the document pager. A thin wrapper over the
 * shared {@link SelectList} primitive — it only formats {@link InspectItem}s into
 * list rows; navigation/selection are the parent's (reducer-driven) concern.
 */
import React from "react"
import { useCliTranslations } from "../../i18n"

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
  const t = useCliTranslations("cliUiCommands")
  const rows = items.map((it) => ({
    label: it.summary
      ? `${it.label}  ${it.summary === "shell" ? t("inspectShell") : it.summary === "subagent" ? t("inspectSubagent") : it.summary}`
      : it.label,
    hint:
      it.lines > 0
        ? t(it.lines === 1 ? "inspectLine" : "inspectLines", { count: it.lines })
        : undefined,
  }))
  return (
    <SelectList
      title={t("inspectTitle")}
      items={rows}
      index={index}
      width={width}
      maxRows={maxRows}
      query={query}
      searchPlaceholder={t("inspectSearch")}
      emptyHint={t("inspectNoMatches")}
      onQueryChange={onQueryChange}
      onMove={onMove}
      onSelect={onSelect}
      onCancel={onCancel}
      footerHint={t("inspectNavigation")}
    />
  )
}
