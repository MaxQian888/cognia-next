/**
 * The `/help` overlay: the command catalog grouped by category, plus key hints.
 * Any key closes it.
 */
import React from "react"
import { Box, Text, useInput } from "ink"

import { listVisibleCommands } from "../../commands/registry"
import { groupByCategory } from "../../commands/help-model"
import { formatArgHint } from "../../commands/arg-hint"

export function Help({ onClose }: { onClose: () => void }) {
  useInput((_input, key) => {
    if (key.escape || key.return) onClose()
  })
  const groups = groupByCategory(listVisibleCommands())
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        Commands
      </Text>
      {groups.map((group) => (
        <Box key={group.category} flexDirection="column">
          <Text bold color="yellow">
            {group.label}
          </Text>
          {group.commands.map((cmd) => {
            const hint = formatArgHint(cmd)
            return (
              <Text key={cmd.name}>
                <Text color="green">/{cmd.name.padEnd(10)}</Text>
                <Text color="gray">{cmd.description}</Text>
                {hint ? <Text color="gray" dimColor>{` ${hint}`}</Text> : null}
              </Text>
            )
          })}
        </Box>
      ))}
      <Text color="gray" dimColor>
        Enter submit · Shift+Enter newline · ↑/↓ history · @ files · Ctrl+R expand/collapse tool
        output · Ctrl+C exit · Esc interrupt
      </Text>
    </Box>
  )
}
