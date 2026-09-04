/**
 * The single line shown under the banner while an external agent backend comes
 * up, before the composer opens.
 *
 * The startup phase used to have no progress indicator at all: the process was
 * spawned lazily on the first turn, so a slow cold start looked like the footer
 * claiming "working" on a turn that had not begun. Naming the current step also
 * gives the failure page somewhere to point — "failed while checking sandbox"
 * is a diagnosis; "failed to start" is not.
 *
 * Pure presenter apart from the spinner, which owns its own frame timer exactly
 * like the footer's, and is never asserted.
 */
import React from "react"
import { Box, Text } from "ink"
import { Spinner } from "./Spinner"

import { useTheme } from "../theme/context"
import { connectProgressLine, type BackendConnectStage } from "../runtime/backend-controller"

export function BackendConnect({
  backend,
  stage,
  width,
}: {
  backend: string
  stage: BackendConnectStage
  width?: number | string
}) {
  const theme = useTheme()
  return (
    <Box flexDirection="column" width={width}>
      <Box>
        <Text color={theme.accent}>
          <Spinner />
        </Text>
        <Text color={theme.muted}>{` ${connectProgressLine(backend, stage)}`}</Text>
      </Box>
      <Text color={theme.muted} dimColor>
        {"Esc to cancel"}
      </Text>
    </Box>
  )
}
