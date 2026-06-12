/**
 * The status footer: a customizable, ordered set of segments (model · provider ·
 * mode · tokens · ctx · cost · cwd · git) in one of four color themes, plus a
 * spinner + interrupt hint while a turn runs and a determinate progress pill for
 * background activity. Segment selection + theme come from `config.statusBar`
 * (defaults preserve the original footer); the view-model is the pure
 * `buildStatusBar`. The spinner is the only animated piece and is never asserted.
 */
import React from "react"
import { Box, Text } from "ink"
import Spinner from "ink-spinner"

import { buildStatusBar, progressBar, readGitBranch, resolveSegments } from "../format/status-bar"
import type { ResolvedConfig } from "../../config/schema"
import type { ActivityState, SessionTotals, TurnStatus, UsageInfo } from "../state/types"
import { WorkingIndicator } from "./WorkingIndicator"

export function Footer({
  config,
  usage,
  totals,
  turnStatus,
  activity,
  gitBranch,
  contextWindow,
  verbose = false,
  planTitle,
}: {
  config: ResolvedConfig
  usage?: UsageInfo
  totals?: SessionTotals
  turnStatus: TurnStatus
  activity?: ActivityState
  /** Pre-resolved git branch; when omitted it is read from `<cwd>/.git/HEAD`
   * only if the `git` segment is enabled. Injected by tests. */
  gitBranch?: string | null
  /** Per-model context window (from the catalog) for the `ctx` segment. */
  contextWindow?: number
  /** Detailed-output mode (Ctrl+O) is on — shown as a footer chip. */
  verbose?: boolean
  /** Title of the session's latest captured plan; shown as a `📋` chip so the
   * plan stays visible at a glance (open it full-screen with `/plan`). */
  planTitle?: string
}) {
  const busy = turnStatus !== "idle"
  const wantsGit = resolveSegments(config).includes("git")
  const git = gitBranch !== undefined ? gitBranch : wantsGit ? readGitBranch(config.cwd) : null
  const segments = buildStatusBar({ config, usage, totals, git, contextWindow })

  return (
    <Box flexDirection="column">
      {activity ? (
        <Text color="magenta">
          {"⟳ "}
          {activity.kind} · {activity.label}
          {typeof activity.turns === "number" && typeof activity.max === "number"
            ? ` · ${progressBar(activity.turns, activity.max)} ${activity.turns}/${activity.max}`
            : typeof activity.turns === "number"
              ? ` · turn ${activity.turns}`
              : ""}
          {activity.note ? ` · ${activity.note}` : ""} · esc to cancel
        </Text>
      ) : null}
      <Box>
        {busy ? (
          <Text color="yellow">
            <Spinner type="dots" /> <WorkingIndicator turnStatus={turnStatus} /> · esc to interrupt
            ·{" "}
          </Text>
        ) : null}
        {segments.map((seg, i) => (
          <Text key={seg.id} color={seg.color} dimColor={seg.dim}>
            {i > 0 ? " · " : ""}
            {seg.text}
          </Text>
        ))}
        {verbose ? <Text color="cyan"> · detail</Text> : null}
        {planTitle ? (
          <Text color="cyan" dimColor>
            {" · 📋 "}
            {planTitle}
          </Text>
        ) : null}
      </Box>
    </Box>
  )
}
