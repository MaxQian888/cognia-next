import React, { useState } from "react"
import { Box, Text } from "ink"
import { useCliTranslations } from "../i18n"
import { useModalInput } from "../input/input-router"
import { truncateToWidth } from "../markdown/width"
import { SelectList } from "./SelectList"
import { DocumentViewer } from "./overlays/DocumentViewer"
import { OVERLAY_CHROME_ROWS, wrappedRows } from "./overlay-layout"

export interface ToolBrowserEntry {
  id: string
  name: string
  description: string
  detail: string
  source: string
  enabled?: boolean
}

/** Shared paginated inventory; tool inspection never invokes a tool. */
export function ToolBrowser({
  title,
  entries,
  width = 80,
  maxRows = 12,
  onClose,
  onToggle,
  isActive = true,
}: {
  title: string
  entries: ToolBrowserEntry[]
  width?: number | string
  maxRows?: number
  onClose: () => void
  onToggle?: (entry: ToolBrowserEntry) => void
  isActive?: boolean
}) {
  const t = useCliTranslations("cliUiCommon")
  const [query, setQuery] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const columns = typeof width === "number" ? width : 80
  const filtered = entries.filter((entry) =>
    [entry.name, entry.description, entry.source, entry.detail].some((value) =>
      value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
    )
  )
  const found = filtered.findIndex((entry) => entry.id === selectedId)
  const index = found < 0 ? 0 : found
  const footer = t(onToggle ? "toolsBrowser.navigationToggle" : "toolsBrowser.navigation")
  const pageSize = Math.max(
    1,
    Math.floor(maxRows - 1 - Math.max(0, wrappedRows(footer, Math.max(1, columns - 4)) - 1))
  )
  const page = Math.floor(index / pageSize)
  const start = page * pageSize
  const visible = filtered.slice(start, start + pageSize)
  const detail = entries.find((entry) => entry.id === detailId)
  const move = (delta: number) =>
    setSelectedId(filtered[Math.max(0, Math.min(filtered.length - 1, index + delta))]?.id ?? null)
  useModalInput(
    (input, key) => {
      if (key.pageDown || key.rightArrow) move(pageSize)
      else if (key.pageUp || key.leftArrow) move(-pageSize)
      else if (onToggle && filtered[index]) onToggle(filtered[index])
    },
    {
      isActive: isActive && !detail,
      shouldHandle: (input, key) =>
        Boolean(
          key.pageDown ||
          key.pageUp ||
          key.leftArrow ||
          key.rightArrow ||
          (input === " " && !query && onToggle)
        ),
    }
  )
  if (detail)
    return (
      <DocumentViewer
        title={detail.name}
        body={[
          detail.description || t("toolsBrowser.noDescription"),
          t("toolsBrowser.source", { source: detail.source }),
          ...(detail.enabled === undefined
            ? []
            : [t(detail.enabled ? "toolsBrowser.enabled" : "toolsBrowser.disabled")]),
          detail.detail,
        ].join("\n\n")}
        format="markdown"
        columns={columns}
        viewportRows={maxRows + OVERLAY_CHROME_ROWS}
        onClose={() => setDetailId(null)}
      />
    )
  return (
    <Box flexDirection="column" width={width}>
      <SelectList
        title={truncateToWidth(title, Math.max(1, columns - 4))}
        width={width}
        maxRows={pageSize}
        index={index - start}
        items={visible.map((entry) => ({
          label: truncateToWidth(
            `${entry.enabled === undefined ? "" : entry.enabled ? "[✓] " : "[ ] "}${entry.name} — ${entry.description || t("toolsBrowser.noDescription")}`.replace(
              /\s+/g,
              " "
            ),
            Math.max(1, columns - 6)
          ),
        }))}
        query={query}
        onQueryChange={(value) => {
          setQuery(value)
          setSelectedId(null)
        }}
        searchPlaceholder={t("toolsBrowser.search")}
        emptyHint={t("toolsBrowser.empty")}
        footerHint={footer}
        onMove={move}
        onSelect={(local) => setDetailId(visible[local]?.id ?? null)}
        isActive={isActive}
        onCancel={() => {
          if (query) {
            setQuery("")
            setSelectedId(null)
          } else onClose()
        }}
      />
      <Text>
        {t("toolsBrowser.page", {
          page: filtered.length ? page + 1 : 0,
          pages: Math.ceil(filtered.length / pageSize),
          from: filtered.length ? start + 1 : 0,
          to: Math.min(start + pageSize, filtered.length),
          total: filtered.length,
        })}
      </Text>
    </Box>
  )
}
