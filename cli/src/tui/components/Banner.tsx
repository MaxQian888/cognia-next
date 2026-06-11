/**
 * The welcome banner — the "top bar". A one-time header pinned to the top of the
 * scrollback (rendered as the first `<Static>` row by {@link Transcript}, and
 * shown on its own during the `"startup"` phase). Mirrors Claude Code's launch
 * banner: a logo line, the active provider/model, the working directory, and a
 * one-line hint. Pure presenter — every value is a prop.
 */
import React from "react"
import { Box, Text } from "ink"

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
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text>
        <Text color="cyan" bold>
          {"✻ Cognia Agent"}
        </Text>
        <Text color="gray">{` v${version}`}</Text>
      </Text>
      <Text color="gray">
        {provider}
        {model ? ` · ${model}` : ""}
      </Text>
      <Text color="gray">{shortenCwd(cwd, 80)}</Text>
      <Text color="gray" dimColor>
        {"/help for commands · @ for files · ! to run a shell command"}
      </Text>
    </Box>
  )
}
