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

const MAX_ROWS = 8

export function FileCompleter({ completions, index }: { completions: string[]; index: number }) {
  if (completions.length === 0) return null
  const shown = completions.slice(0, MAX_ROWS)
  const overflow = completions.length - shown.length
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      {shown.map((path, i) => {
        const isDir = path.endsWith("/")
        const selected = i === index
        return (
          <Text key={path} color={selected ? "cyan" : isDir ? "blue" : undefined} bold={selected}>
            {selected ? "❯ " : "  "}
            {isDir ? "📁 " : "   "}
            {path}
          </Text>
        )
      })}
      {overflow > 0 && (
        <Text color="gray" dimColor>
          {`  +${overflow} more`}
        </Text>
      )}
    </Box>
  )
}
