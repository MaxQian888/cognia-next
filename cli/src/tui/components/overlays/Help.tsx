/**
 * The `/help` overlay: the command catalog grouped by category, plus key hints.
 * Any key closes it.
 */
import React from "react"
import { Box, Text } from "ink"
import { useModalInput } from "../../input/input-router"

import { listVisibleCommands } from "../../commands/registry"
import { groupByCategory } from "../../commands/help-model"
import { formatArgHint } from "../../commands/arg-hint"
import { useTheme } from "../../theme/context"
import {
  PANEL_CHROME_ROWS,
  PanelViewport,
  panelFooterHint,
  usePanelScroll,
} from "../../hooks/usePanelScroll"

/** Narrowest and widest the command-name column may be. The floor keeps short
 * catalogues from looking cramped, the ceiling keeps one long name from pushing
 * every description off a narrow terminal. */
const HELP_NAME_MIN = 12
const HELP_NAME_MAX = 18

/** Width of the command-name column: the longest name plus its leading slash
 * and one space of gutter, clamped. Pure, so the layout is testable without Ink. */
export function helpNameColumn(names: string[]): number {
  const longest = names.reduce((max, name) => Math.max(max, name.length), 0)
  return Math.min(HELP_NAME_MAX, Math.max(HELP_NAME_MIN, longest + 2))
}

export function Help({
  onClose,
  viewportRows = 24,
}: {
  onClose: () => void
  viewportRows?: number
}) {
  const theme = useTheme()
  const contentViewportRows = Math.max(1, viewportRows - PANEL_CHROME_ROWS)
  const scroll = usePanelScroll(contentViewportRows)
  useModalInput((input, key) => {
    if (scroll.onKey(input, key)) return
    if (key.escape || key.return) onClose()
  })
  const groups = groupByCategory(listVisibleCommands())
  // One name column across every group, sized to the longest visible command so
  // the descriptions line up. `padEnd(10)` used to do this, and any name of ten
  // characters or more ("/transcript", "/capabilities") came out glued to its
  // description with no separating space at all.
  const nameColumn = helpNameColumn(groups.flatMap((group) => group.commands.map((c) => c.name)))
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text bold color={theme.accent}>
        Commands
      </Text>
      <PanelViewport viewportRows={contentViewportRows} scroll={scroll}>
        {groups.map((group) => (
          <Box key={group.category} flexDirection="column">
            <Text bold color={theme.warning}>
              {group.label}
            </Text>
            {group.commands.map((cmd) => {
              const hint = formatArgHint(cmd)
              return (
                // Two boxes, not one wrapped Text: a description long enough to
                // wrap then continues under its own column instead of restarting
                // at the panel's left edge, under the command names.
                <Box key={cmd.name}>
                  <Box width={nameColumn} flexShrink={0}>
                    <Text color={theme.success}>/{cmd.name}</Text>
                  </Box>
                  <Box flexGrow={1}>
                    <Text color={theme.muted}>
                      {cmd.description}
                      {hint ? <Text dimColor>{` ${hint}`}</Text> : null}
                    </Text>
                  </Box>
                </Box>
              )
            })}
          </Box>
        ))}
        <Text color={theme.muted} dimColor>
          Enter submit · Shift+Enter newline · Tab complete · ↑/↓ history · @ files · Ctrl+R history
          search · Ctrl+T expand/collapse tool output · Ctrl+I inspect workflow step · Ctrl+V paste
          image · Ctrl+C exit · Esc interrupt
        </Text>
        <Text color={theme.muted} dimColor>
          btw: type while a /goal or /loop run is working to steer it — your message is queued and
          delivered at the next turn boundary (never interrupts the turn).
        </Text>
      </PanelViewport>
      <Text color={theme.muted} dimColor>
        {panelFooterHint(scroll.hidden)}
      </Text>
    </Box>
  )
}
