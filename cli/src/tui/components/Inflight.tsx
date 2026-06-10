/**
 * The single mutating region below the transcript that shows the current turn's
 * live reasoning and streaming answer before they commit to permanent cells.
 */
import React from "react"
import { Box, Text } from "ink"

import { Markdown } from "./Markdown"
import type { Inflight as InflightState } from "../state/types"

export function Inflight({ inflight }: { inflight: InflightState }) {
  const hasThinking = inflight.thinking.length > 0
  const hasText = inflight.text.length > 0
  if (!hasThinking && !hasText) return null
  return (
    <Box flexDirection="column" marginBottom={1}>
      {hasThinking && (
        <Text color="magenta" dimColor>
          {inflight.thinking}
        </Text>
      )}
      {hasText && <Markdown raw={inflight.text} />}
    </Box>
  )
}
