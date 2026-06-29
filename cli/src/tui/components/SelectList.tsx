/**
 * A controlled keyboard select list: arrow keys move the highlight, Enter
 * selects, Esc cancels. Stateless — the parent owns `index` and reacts to
 * `onMove` / `onSelect` / `onCancel`, so the same primitive backs both
 * reducer-driven overlays and input-local popups.
 */
import React, { useRef } from "react"
import { Box, Text, useInput, type DOMElement } from "ink"

import { useTheme } from "../theme/context"
import { windowList } from "./list-window"
import { OverlayFooter } from "./OverlayFooter"
import { usePanelClick } from "../input/use-panel-click"

export interface SelectItem {
  label: string
  hint?: string
}

export function SelectList({
  title,
  items,
  index,
  onMove,
  onSelect,
  onCancel,
  isActive = true,
  maxRows,
  width,
  footerHint,
}: {
  title?: string
  items: SelectItem[]
  index: number
  onMove: (delta: number) => void
  onSelect: (index: number) => void
  onCancel?: () => void
  isActive?: boolean
  /** Cap the number of visible rows; the list scrolls to keep the highlighted
   * row on-screen. Omitted → show every item (the previous behaviour). */
  maxRows?: number
  /** Box width (e.g. terminal columns) so the panel spans the full width. */
  width?: number | string
  /** Override the bottom key-hint line; pass `false` to hide it. Defaults to the
   * shared `↑/↓ navigate · Enter select · Esc cancel`. */
  footerHint?: string | false
}) {
  const theme = useTheme()
  const boxRef = useRef<DOMElement | null>(null)

  const win = windowList(items.length, index, maxRows ?? items.length)
  const visible = items.slice(win.start, win.end)

  // Mouse (fullscreen `scroll` mode only): a click on a row both highlights and
  // selects it (Claude-Code parity); the wheel moves the highlight. Header rows
  // above the items = the optional title line.
  const handleMouse = usePanelClick({
    boxRef,
    headerRows: title ? 1 : 0,
    hasAboveMore: win.above > 0,
    visibleCount: visible.length,
    onPick: (offset) => {
      const target = win.start + offset
      onMove(target - index)
      onSelect(target)
    },
    onWheel: (dir) => onMove(dir === "up" ? -1 : 1),
  })

  useInput(
    (input, key) => {
      if (handleMouse(input)) return
      if (key.upArrow) onMove(-1)
      else if (key.downArrow) onMove(1)
      else if (key.return) onSelect(index)
      else if (key.escape) onCancel?.()
    },
    { isActive }
  )

  return (
    <Box
      ref={boxRef}
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
      width={width}
    >
      {title ? <Text bold>{title}</Text> : null}
      {win.above > 0 ? <Text color={theme.muted} dimColor>{`  ↑ ${win.above} more`}</Text> : null}
      {visible.map((item, i) => {
        const row = win.start + i
        return (
          <Text key={row} color={row === index ? theme.accent : undefined} bold={row === index}>
            {row === index ? "❯ " : "  "}
            {item.label}
            {item.hint ? <Text color={theme.muted}> {item.hint}</Text> : null}
          </Text>
        )
      })}
      {win.below > 0 ? <Text color={theme.muted} dimColor>{`  ↓ ${win.below} more`}</Text> : null}
      {footerHint === false ? null : <OverlayFooter hint={footerHint || undefined} />}
    </Box>
  )
}
