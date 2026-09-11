import React, { useState } from "react"
import { Box, Text } from "ink"
import { useCliTranslations } from "../../i18n"
import { useModalInput } from "../../input/input-router"
import type { HookPanelRow } from "../../runtime/hooks-controller"
import { useTheme } from "../../theme/context"
import { SelectList } from "../SelectList"
import { moveIndex } from "../select-list-state"
import { OVERLAY_CHROME_ROWS, wrappedRows } from "../overlay-layout"
import { DocumentViewer } from "./DocumentViewer"

const DIAGNOSTICS = "hooks:diagnostics"

export interface HooksOverlayProps {
  rows: HookPanelRow[]
  diagnostics: string[]
  width: number
  /** Shared list item budget; border/title/footer chrome is additional. */
  maxRows: number
  onToggle: (row: HookPanelRow) => void
  onEdit: (source: "cognia" | "claude") => void
  onRefresh: () => void
  onClose: () => void
}

/** Configured inventory, with read-only full details and explicit configuration actions. */
export function HooksOverlay({
  rows,
  diagnostics,
  width,
  maxRows,
  onToggle,
  onEdit,
  onRefresh,
  onClose,
}: HooksOverlayProps) {
  const t = useCliTranslations("cliUiHooks")
  const theme = useTheme()
  const [query, setQuery] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const normalized = query.trim().toLocaleLowerCase()
  const filtered = rows.filter((row) =>
    [
      row.label,
      row.event,
      row.source,
      row.sourcePath ?? "",
      row.detail,
      t(`ui.sources.${row.source}`),
    ].some((value) => value.toLocaleLowerCase().includes(normalized))
  )
  const items = filtered.map((row) => ({
    id: row.id,
    label: `${row.source === "builtin" ? (row.enabled ? "[✓] " : "[ ] ") : ""}${row.label}`,
    hint: `${row.event} · ${t(`ui.sources.${row.source}`)}`,
    row,
  }))
  const listItems = diagnostics.length
    ? [
        {
          id: DIAGNOSTICS,
          label: t("ui.diagnostics", { count: diagnostics.length }),
          hint: "",
          row: undefined,
        },
        ...items,
      ]
    : items
  const selectedIndex = listItems.findIndex((item) => item.id === selectedId)
  const index = selectedIndex < 0 ? 0 : selectedIndex
  const selected = listItems[index]?.row
  const detail = rows.find((row) => row.id === detailId)
  const showingDiagnostics = detailId === DIAGNOSTICS && diagnostics.length > 0
  const showingDetail = Boolean(detail || showingDiagnostics)
  const footer = t("ui.navigation")
  const actions = t("ui.actions")
  const secondaryRows = wrappedRows(actions, Math.max(1, width))

  useModalInput(
    (input, key) => {
      if (key.ctrl && input === "r") onRefresh()
      else if (key.ctrl && input === "e") onEdit("cognia")
      else if (key.ctrl && input === "l") onEdit("claude")
      else if (input === " " && !query && selected?.source === "builtin") onToggle(selected)
    },
    {
      isActive: !showingDetail,
      shouldHandle: (input, key) =>
        (key.ctrl && ["r", "e", "l"].includes(input)) ||
        (!key.ctrl && !key.meta && input === " " && !query && selected?.source === "builtin"),
    }
  )

  if (showingDetail)
    return (
      <DocumentViewer
        key={detailId}
        title={
          showingDiagnostics ? t("ui.diagnostics", { count: diagnostics.length }) : detail!.label
        }
        body={showingDiagnostics ? diagnostics.join("\n\n") : detail!.detail}
        format="markdown"
        columns={width}
        viewportRows={maxRows + OVERLAY_CHROME_ROWS}
        onClose={() => setDetailId(null)}
      />
    )

  return (
    <Box flexDirection="column" width={width}>
      <SelectList
        title={t("ui.title", { count: rows.length })}
        items={listItems}
        index={index}
        query={query}
        onQueryChange={(value) => setQuery(value)}
        searchPlaceholder={t("ui.search")}
        emptyHint={t(rows.length ? "ui.noMatches" : "ui.empty")}
        width={width}
        maxRows={Math.max(
          1,
          maxRows - 1 - secondaryRows - Math.max(0, wrappedRows(footer, Math.max(1, width - 4)) - 1)
        )}
        footerHint={footer}
        onMove={(delta) =>
          setSelectedId(listItems[moveIndex(index, delta, listItems.length)]?.id ?? null)
        }
        onSelect={(next) => {
          const item = listItems[next]
          if (!item) return
          setSelectedId(item.id)
          setDetailId(item.id)
        }}
        onCancel={onClose}
      />
      <Text color={theme.muted}>{actions}</Text>
    </Box>
  )
}
