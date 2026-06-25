/**
 * The incremental find bar shown above the composer in the fullscreen layout
 * while Ctrl+F find is active. Purely presentational: it renders the live query,
 * a match counter, and the key hint. All state (query, matches, current index)
 * lives in the transcript cursor; key routing lives in `App`. Keeping it dumb
 * means the whole find state machine unit-tests without Ink.
 *
 * Counter states: empty query → a "type to search" prompt; matches → `i/n`;
 * a non-empty query with no hits → "No matches".
 */
import React from "react"
import { Box, Text } from "ink"

import { useTheme } from "../theme/context"

export interface FindBarProps {
  /** The query the user has typed so far. */
  query: string
  /** Total number of matching lines. */
  matchCount: number
  /** Zero-based index of the current match (shown 1-based). */
  matchIndex: number
}

export function FindBar({ query, matchCount, matchIndex }: FindBarProps) {
  const theme = useTheme()

  let counter: string
  let counterColor: string | undefined
  if (query === "") {
    counter = "type to search"
    counterColor = theme.muted
  } else if (matchCount === 0) {
    counter = "No matches"
    counterColor = theme.warning
  } else {
    counter = `${matchIndex + 1}/${matchCount}`
    counterColor = theme.muted
  }

  return (
    <Box>
      <Text color={theme.accent} bold>
        {"⌕ "}
      </Text>
      <Text>{query}</Text>
      <Text color={theme.accent}>▏</Text>
      <Text color={counterColor} dimColor>
        {"  "}
        {counter}
        {"  · ↵/↓ next · ↑ prev · esc close"}
      </Text>
    </Box>
  )
}
