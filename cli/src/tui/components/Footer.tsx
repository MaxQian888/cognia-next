/**
 * The status footer: model · provider · mode · tokens · context% · cost · cwd,
 * with a spinner + interrupt hint while a turn runs. All values come from the
 * pure `formatFooter` view-model; the spinner is the only animated piece and is
 * never asserted in tests.
 */
import React from "react"
import { Box, Text } from "ink"
import Spinner from "ink-spinner"

import { formatFooter } from "../format/usage"
import type { ResolvedConfig } from "../../config/schema"
import type { TurnStatus, UsageInfo } from "../state/types"

export function Footer({
  config,
  usage,
  turnStatus,
}: {
  config: ResolvedConfig
  usage?: UsageInfo
  turnStatus: TurnStatus
}) {
  const f = formatFooter({
    model: config.model,
    provider: config.provider,
    mode: config.permissionMode,
    cwd: config.cwd,
    usage,
  })
  const busy = turnStatus !== "idle"
  return (
    <Box>
      {busy ? (
        <Text color="yellow">
          <Spinner type="dots" /> {turnStatus === "aborting" ? "stopping" : "working"} · esc to
          interrupt ·{" "}
        </Text>
      ) : null}
      <Text color="cyan">{f.model}</Text>
      <Text color="gray">
        {" "}
        · {f.provider} · {f.mode} · {f.tokens} tok · {f.contextPct}% ctx · {f.cost} · {f.cwd}
      </Text>
    </Box>
  )
}
