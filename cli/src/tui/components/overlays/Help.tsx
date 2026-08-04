/**
 * The `/help` overlay: the command catalog grouped by category, plus key hints.
 * Any key closes it.
 */
import React from "react"
import { Box, Text, useInput, useStdout } from "ink"

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

export function Help({ onClose, maxRows }: { onClose: () => void; maxRows?: number }) {
  const theme = useTheme()
  const { stdout } = useStdout()
  const viewportRows = Math.max(
    3,
    (maxRows ?? (stdout?.rows as number | undefined) ?? 24) - PANEL_CHROME_ROWS
  )
  const scroll = usePanelScroll(viewportRows)
  useInput((input, key) => {
    if (scroll.onKey(input, key)) return
    if (key.escape || key.return) onClose()
  })
  const groups = groupByCategory(listVisibleCommands())
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text bold color={theme.accent}>
        Commands
      </Text>
      <PanelViewport viewportRows={viewportRows} scroll={scroll}>
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
