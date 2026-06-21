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
import { useTheme } from "../theme/context"
import type { RateLimitSnapshot } from "../format/rate-limits"
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
  rateLimits,
  verbose = false,
  planTitle,
  steerCount = 0,
  subagentRunning,
  backgroundSubagents = 0,
  copilot,
}: {
  config: ResolvedConfig
  usage?: UsageInfo
  totals?: SessionTotals
  turnStatus: TurnStatus
  activity?: ActivityState
  /** The sub-agent dispatches running in the current turn (name of the most
   * recent + how many), for a lightweight `◆` footer chip. Absent when none. */
  subagentRunning?: { name: string; count: number } | null
  /** Count of detached (`background: true`) subagent runs still in flight,
   * surviving across turns until collected — shown as a `⧗ N bg` chip. */
  backgroundSubagents?: number
  /** Pre-resolved git branch; when omitted it is read from `<cwd>/.git/HEAD`
   * only if the `git` segment is enabled. Injected by tests. */
  gitBranch?: string | null
  /** Per-model context window (from the catalog) for the `ctx` segment. */
  contextWindow?: number
  /** Live API rate-limit reading for the `ratelimit` segment. */
  rateLimits?: RateLimitSnapshot
  /** Detailed-output mode (Ctrl+O) is on — shown as a footer chip. */
  verbose?: boolean
  /** Count of queued `btw` steer messages awaiting the next turn boundary. */
  steerCount?: number
  /** Title of the session's latest captured plan; shown as a `📋` chip so the
   * plan stays visible at a glance (open it full-screen with `/plan`). */
  planTitle?: string
  /** Active Workflow Copilot draft name; shown as a `⚙` chip so the user always
   * knows free-text is routing to the copilot, plus the exit hint. */
  copilot?: { name: string } | null
}) {
  const theme = useTheme()
  const busy = turnStatus !== "idle"
  const wantsGit = resolveSegments(config).includes("git")
  const git = gitBranch !== undefined ? gitBranch : wantsGit ? readGitBranch(config.cwd) : null
  const segments = buildStatusBar({
    config,
    usage,
    totals,
    git,
    contextWindow,
    rateLimits,
    palette: theme,
  })

  return (
    <Box flexDirection="column" flexShrink={0}>
      {activity ? (
        <Text color={theme.secondary}>
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
          <Text color={theme.warning}>
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
        {verbose ? <Text color={theme.accent}> · detail</Text> : null}
        {steerCount > 0 ? (
          <Text color={theme.secondary}>
            {" · 💬 btw×"}
            {steerCount}
          </Text>
        ) : null}
        {planTitle ? (
          <Text color={theme.accent} dimColor>
            {" · 📋 "}
            {planTitle}
          </Text>
        ) : null}
        {copilot ? (
          <Text color={theme.info}>
            {" · ⚙ copilot: "}
            {copilot.name}
            {" (/workflow exit)"}
          </Text>
        ) : null}
        {subagentRunning ? (
          <Text color={theme.secondary}>
            {" · ◆ "}
            {subagentRunning.name}
            {subagentRunning.count > 1 ? `×${subagentRunning.count}` : ""}
          </Text>
        ) : null}
        {backgroundSubagents > 0 ? (
          <Text color={theme.info}>
            {" · ⧗ "}
            {backgroundSubagents}
            {" bg"}
          </Text>
        ) : null}
        {/* Persistent discoverability hint — only when idle so it never competes
            with the spinner / activity pill. Keeps `/settings` one glance away. */}
        {!busy && !activity ? (
          <Text color={theme.muted} dimColor>
            {" · ⚙ /settings · ▸ /inspect"}
          </Text>
        ) : null}
      </Box>
    </Box>
  )
}
