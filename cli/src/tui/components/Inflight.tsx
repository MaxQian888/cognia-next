/**
 * The single mutating region below the transcript that shows the current turn's
 * live reasoning, streaming answer, and running tool calls before they commit to
 * permanent cells.
 *
 * Reasoning is collapsed by default — just a `✻ Thinking…` indicator — so a long
 * chain-of-thought doesn't flood the terminal mid-turn. Tool cells stay live here
 * so status transitions (⏳→✓, ⏳→✗) re-render instantly; once a tool completes
 * it is moved to `<Static>` cells at the next commit boundary.
 */
import React from "react"
import { Box, Text } from "ink"

import { Markdown } from "./Markdown"
import { useTheme } from "../theme/context"
import { useRenderPrefs } from "../render/context"
import { usePacedReveal } from "../render/use-paced-reveal"
import type { Inflight as InflightState } from "../state/types"
import { CellView } from "./CellView"

export function Inflight({
  inflight,
  verbose = false,
}: {
  inflight: InflightState
  /** Detail mode (Ctrl+O): when on, the live reasoning text is shown in full. */
  verbose?: boolean
}) {
  const theme = useTheme()
  // Paced "typing" reveal of the live answer — only on an interactive TTY, and
  // opt-out via render prefs. Hooks run before the early return to keep order
  // stable. When disabled the hook returns the full text unchanged.
  const prefs = useRenderPrefs()
  const revealEnabled = prefs.streamReveal && Boolean(process.stdout.isTTY)
  const revealedText = usePacedReveal(inflight.text, revealEnabled)
  const hasThinking = inflight.thinking.length > 0
  const hasText = inflight.text.length > 0
  const hasTools = inflight.tools.length > 0
  if (!hasThinking && !hasText && !hasTools) return null
  return (
    <Box flexDirection="column" marginBottom={1}>
      {hasThinking && (
        <Box flexDirection="column">
          <Text>
            <Text color={theme.thinking} italic>
              ✻ Thinking…
            </Text>
            {!verbose && (
              <Text color={theme.muted} dimColor>
                {" "}
                ctrl+o to expand
              </Text>
            )}
          </Text>
          {verbose && (
            <Text color={theme.thinking} dimColor>
              {inflight.thinking}
            </Text>
          )}
        </Box>
      )}
      {hasTools && (
        <Box flexDirection="column" marginBottom={1}>
          {inflight.tools.map((tool) => (
            <CellView key={tool.id} cell={tool} />
          ))}
        </Box>
      )}
      {hasText && <Markdown raw={revealedText} />}
    </Box>
  )
}
