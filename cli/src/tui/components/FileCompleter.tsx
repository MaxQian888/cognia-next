/**
 * Presentational `@path` completion list shown below the composer. Stateless —
 * the `Input` component owns the keyboard and the highlighted index.
 *
 * Directories (paths ending in `/`) carry a folder glyph and are tinted blue so
 * the file/folder split is readable at a glance; the highlighted row always wins
 * the accent color. Up to 8 rows render, with a "+N more" footer when the list
 * overflows.
 */
import React from "react"
import { Box, Text } from "ink"

import { useTheme } from "../theme/context"
import { windowList } from "./list-window"

const MAX_ROWS = 8

export function FileCompleter({
  completions,
  index,
  maxRows = MAX_ROWS,
  width,
}: {
  completions: string[]
  index: number
  /** Cap the visible rows; the list scrolls to keep the highlighted row on-screen
   * so arrowing past the fold never hides the cursor. */
  maxRows?: number
  /** Box width (terminal columns) so the popup spans the full width. */
  width?: number | string
}) {
  const theme = useTheme()
  if (completions.length === 0) return null
  const win = windowList(completions.length, index, maxRows)
  const visible = completions.slice(win.start, win.end)
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.borderSubtle}
      paddingX={1}
      width={width}
    >
      {win.above > 0 && <Text color={theme.muted} dimColor>{`  ↑ ${win.above} more`}</Text>}
      {visible.map((path, i) => {
        const row = win.start + i
        const isDir = path.endsWith("/")
        const selected = row === index
        return (
          <Text
            key={path}
            color={selected ? theme.accent : isDir ? theme.info : undefined}
            bold={selected}
          >
            {selected ? "❯ " : "  "}
            {isDir ? "📁 " : "   "}
            {path}
          </Text>
        )
      })}
      {win.below > 0 && <Text color={theme.muted} dimColor>{`  ↓ ${win.below} more`}</Text>}
    </Box>
  )
}
