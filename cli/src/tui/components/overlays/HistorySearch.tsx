/**
 * The Ctrl+R reverse-history-search overlay — a readline-style incremental
 * search over the composer history. Controlled presenter: the live `query` and
 * the current `match` are owned by the App (which re-runs the pure
 * `searchHistory` matcher); this component renders the
 * `(reverse-i-search)`…`: <match>` prompt and translates keys into callbacks.
 *
 * Keys:
 *   • a printable char           → `onChar` (refine the query)
 *   • Backspace                  → `onBackspace`
 *   • Ctrl+R                     → `onNext` (cycle to the next-older match)
 *   • Enter                      → `onAccept` (load the match into the composer)
 *   • Esc                        → `onCancel`
 */
import React from "react"
import { Box, Text, useInput } from "ink"

import { useTheme } from "../../theme/context"

export function HistorySearch({
  query,
  match,
  onChar,
  onBackspace,
  onNext,
  onAccept,
  onCancel,
}: {
  /** The current search query (refined as the user types). */
  query: string
  /** The matched history entry, or null when nothing matches (yet). */
  match: string | null
  onChar: (ch: string) => void
  onBackspace: () => void
  onNext: () => void
  onAccept: () => void
  onCancel: () => void
}) {
  const theme = useTheme()
  useInput((input, key) => {
    if (key.escape) {
      onCancel()
      return
    }
    if (key.ctrl && input === "r") {
      onNext()
      return
    }
    if (key.return) {
      onAccept()
      return
    }
    if (key.backspace || key.delete) {
      onBackspace()
      return
    }
    // Printable text only (ignore other control chords so they don't pollute
    // the query — Ctrl+R is handled above).
    if (input && !key.ctrl && !key.meta) onChar(input)
  })

  const hasMatch = match !== null
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text>
        <Text color={theme.muted}>{"(reverse-i-search)`"}</Text>
        <Text color={theme.accent}>{query}</Text>
        <Text color={theme.muted}>{"': "}</Text>
        <Text color={hasMatch ? undefined : theme.warning}>{hasMatch ? match : "(no match)"}</Text>
      </Text>
      <Text color={theme.muted} dimColor>
        type to search · Ctrl+R older · Enter accept · Esc cancel
      </Text>
    </Box>
  )
}
