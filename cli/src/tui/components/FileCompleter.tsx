/**
 * Presentational `@path` completion list shown below the composer. Stateless —
 * the `Input` component owns the keyboard and the highlighted index.
 */
import React from "react"
import { Box, Text } from "ink"

export function FileCompleter({ completions, index }: { completions: string[]; index: number }) {
  if (completions.length === 0) return null
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      {completions.slice(0, 8).map((path, i) => (
        <Text key={path} color={i === index ? "cyan" : undefined} bold={i === index}>
          {i === index ? "❯ " : "  "}
          {path}
        </Text>
      ))}
    </Box>
  )
}
