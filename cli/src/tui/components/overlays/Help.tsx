/**
 * The `/help` overlay: the command catalog plus key hints. Any key closes it.
 */
import React from "react"
import { Box, Text, useInput } from "ink"

import { SLASH_COMMANDS } from "../../commands/registry"

export function Help({ onClose }: { onClose: () => void }) {
  useInput((_input, key) => {
    if (key.escape || key.return) onClose()
  })
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        Commands
      </Text>
      {SLASH_COMMANDS.map((cmd) => (
        <Text key={cmd.name}>
          <Text color="green">/{cmd.name.padEnd(9)}</Text>
          <Text color="gray">{cmd.description}</Text>
        </Text>
      ))}
      <Text color="gray" dimColor>
        Enter submit · Shift+Enter newline · ↑/↓ history · @ files · Ctrl+C exit · Esc interrupt
      </Text>
    </Box>
  )
}
