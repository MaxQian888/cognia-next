/**
 * Shown while an external agent's CLI is being installed from the failure page.
 *
 * The failure page offers an "Install <agent>" choice when the binary is missing
 * and an official method can run here; choosing it lands on this page — the
 * installer runs unsandboxed (it is the user's own approved command, not the
 * agent) and its output streams in so a long `npm install` / vendor script never
 * looks hung. On success the app re-enters the connect flow automatically; on
 * failure it returns to the recovery page with a toast.
 *
 * Pure presenter apart from the spinner (own frame timer, never asserted). The
 * visible-output windowing is factored into {@link tailLines} so it is testable
 * without rendering.
 */
import React from "react"
import { Box, Text } from "ink"
import Spinner from "ink-spinner"

import { useTheme } from "../theme/context"
import type { BackendInstallState } from "../state/types"

/**
 * The last `max` non-empty-trailing lines of the installer output, so the page
 * shows the freshest progress within a bounded height instead of scrolling the
 * whole log off the top.
 */
export function tailLines(output: string, max: number): string[] {
  const lines = output.split("\n")
  // A trailing newline yields a final empty element; drop it so the window isn't
  // spent on a blank row.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  if (max <= 0) return []
  return lines.slice(-max)
}

export function BackendInstall({
  install,
  width,
  maxRows,
}: {
  install: BackendInstallState
  width?: number | string
  maxRows?: number
}) {
  const theme = useTheme()
  // Leave a couple of rows for the header + command line.
  const budget = Math.max(1, (maxRows ?? 12) - 2)
  const visible = tailLines(install.output, budget)
  return (
    <Box flexDirection="column" width={width}>
      <Box>
        <Text color={theme.accent}>
          <Spinner type="dots" />
        </Text>
        <Text color={theme.muted}>{` Installing ${install.name} …`}</Text>
      </Box>
      <Text color={theme.muted} dimColor>
        {`$ ${install.display}`}
      </Text>
      {visible.map((line, i) => (
        <Text key={i} color={theme.muted} dimColor>
          {line}
        </Text>
      ))}
    </Box>
  )
}
