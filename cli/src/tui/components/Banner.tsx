/**
 * The welcome banner — the "top bar". A one-time header pinned to the top of the
 * scrollback (rendered as the first `<Static>` row by {@link Transcript}, and
 * shown on its own during the `"startup"` phase). Mirrors Claude Code's launch
 * banner: a logo line, the active provider/model, the working directory, and a
 * one-line hint. Pure presenter — every value is a prop.
 */
import React from "react"
import { Box, Text } from "ink"

import { useTheme } from "../theme/context"
import { shortenCwd } from "../format/usage"

export function Banner({
  version,
  provider,
  model,
  cwd,
}: {
  version: string
  provider: string
  model?: string
  cwd: string
}) {
  const theme = useTheme()
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text>
        <Text color={theme.accent} bold>
          {"✻ Cognia Agent"}
        </Text>
        <Text color={theme.muted}>{` v${version}`}</Text>
      </Text>
      <Text color={theme.muted}>
        {provider}
        {model ? ` · ${model}` : ""}
      </Text>
      <Text color={theme.muted}>{shortenCwd(cwd, 80)}</Text>
      <Text color={theme.muted} dimColor>
        {"/settings to configure · /inspect to expand output · /help · @ files · ! shell"}
      </Text>
    </Box>
  )
}
