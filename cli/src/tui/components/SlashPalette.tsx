/**
 * Presentational `/` command palette shown below the composer. Stateless — the
 * `Input` component owns the keyboard and the highlighted index.
 */
import React from "react"
import { Box, Text } from "ink"

import type { SlashCommand } from "../commands/registry"
import { useTheme } from "../theme/context"
import { windowList } from "./list-window"
import { formatArgHint } from "../commands/arg-hint"

const MAX_ROWS = 8

export function SlashPalette({
  matches,
  index,
  query = "",
  maxRows = MAX_ROWS,
  width,
}: {
  matches: SlashCommand[]
  index: number
  /** Text after the leading slash; rendered as an explicit search affordance. */
  query?: string
  /** Cap the visible rows; the list scrolls to keep the highlight on-screen. */
  maxRows?: number
  /** Box width (terminal columns) so the palette spans the full width. */
  width?: number | string
}) {
  const theme = useTheme()
  if (matches.length === 0) return null
  const win = windowList(matches.length, index, maxRows)
  const visible = matches.slice(win.start, win.end)
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.borderSubtle}
      paddingX={1}
      width={width}
    >
      <Text color={theme.muted} wrap="truncate-end">
        Search: <Text color={theme.accent}>{query || "all commands"}</Text>
        {"  ·  ↑/↓ select · Tab complete · Enter run"}
      </Text>
      {win.above > 0 ? <Text color={theme.muted} dimColor>{`  ↑ ${win.above} more`}</Text> : null}
      {visible.map((cmd, i) => {
        const row = win.start + i
        const hint = formatArgHint(cmd)
        return (
          <Text
            key={cmd.name}
            color={row === index ? theme.accent : undefined}
            bold={row === index}
            wrap="truncate-end"
          >
            {row === index ? "❯ " : "  "}/{cmd.name}
            {hint ? <Text color={theme.secondary}> {hint}</Text> : null}
            <Text color={theme.muted}> — {cmd.description}</Text>
          </Text>
        )
      })}
      {win.below > 0 ? <Text color={theme.muted} dimColor>{`  ↓ ${win.below} more`}</Text> : null}
    </Box>
  )
}
