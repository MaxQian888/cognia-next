/**
 * Presentational `/` command palette shown below the composer. Stateless — the
 * `Input` component owns the keyboard and the highlighted index.
 */
import React from "react"
import { Box, Text } from "ink"

import type { SlashCommand } from "../commands/registry"

export function SlashPalette({ matches, index }: { matches: SlashCommand[]; index: number }) {
  if (matches.length === 0) return null
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      {matches.map((cmd, i) => (
        <Text key={cmd.name} color={i === index ? "cyan" : undefined} bold={i === index}>
          {i === index ? "❯ " : "  "}/{cmd.name}
          <Text color="gray"> — {cmd.description}</Text>
        </Text>
      ))}
    </Box>
  )
}
