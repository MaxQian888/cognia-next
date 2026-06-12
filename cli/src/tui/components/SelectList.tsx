/**
 * A controlled keyboard select list: arrow keys move the highlight, Enter
 * selects, Esc cancels. Stateless — the parent owns `index` and reacts to
 * `onMove` / `onSelect` / `onCancel`, so the same primitive backs both
 * reducer-driven overlays and input-local popups.
 */
import React from "react"
import { Box, Text, useInput } from "ink"

import { useTheme } from "../theme/context"
import { windowList } from "./list-window"

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
}) {
  const theme = useTheme()
  useInput(
    (input, key) => {
      if (key.upArrow) onMove(-1)
      else if (key.downArrow) onMove(1)
      else if (key.return) onSelect(index)
      else if (key.escape) onCancel?.()
    },
    { isActive }
  )

  const win = windowList(items.length, index, maxRows ?? items.length)
  const visible = items.slice(win.start, win.end)

  return (
    <Box
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
    </Box>
  )
}
