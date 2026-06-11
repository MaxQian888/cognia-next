/**
 * The single mutating region below the transcript that shows the current turn's
 * live reasoning and streaming answer before they commit to permanent cells.
 *
 * Reasoning is collapsed by default — just a `✻ Thinking…` indicator — so a long
 * chain-of-thought doesn't flood the terminal mid-turn. The full live stream is
 * shown only in verbose (detail) mode, matching how committed thinking cells
 * render. Once the turn commits the reasoning becomes a collapsed thinking cell.
 */
import React from "react"
import { Box, Text } from "ink"

import { Markdown } from "./Markdown"
import type { Inflight as InflightState } from "../state/types"

export function Inflight({
  inflight,
  verbose = false,
}: {
  inflight: InflightState
  /** Detail mode (Ctrl+O): when on, the live reasoning text is shown in full. */
  verbose?: boolean
}) {
  const hasThinking = inflight.thinking.length > 0
  const hasText = inflight.text.length > 0
  if (!hasThinking && !hasText) return null
  return (
    <Box flexDirection="column" marginBottom={1}>
      {hasThinking && (
        <Box flexDirection="column">
          <Text>
            <Text color="magenta" italic>
              ✻ Thinking…
            </Text>
            {!verbose && (
              <Text color="gray" dimColor>
                {" "}
                ctrl+o to expand
              </Text>
            )}
          </Text>
          {verbose && (
            <Text color="magenta" dimColor>
              {inflight.thinking}
            </Text>
          )}
        </Box>
      )}
      {hasText && <Markdown raw={inflight.text} />}
    </Box>
  )
}
