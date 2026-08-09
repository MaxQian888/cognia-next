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
                <Text key={cmd.name}>
                  <Text color={theme.success}>/{cmd.name.padEnd(10)}</Text>
                  <Text color={theme.muted}>{cmd.description}</Text>
                  {hint ? <Text color={theme.muted} dimColor>{` ${hint}`}</Text> : null}
                </Text>
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
