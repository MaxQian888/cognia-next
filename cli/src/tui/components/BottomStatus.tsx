/**
 * The transient "what's happening right now" layer, pinned directly ABOVE the
 * composer (Codex's `StatusIndicatorWidget`). It owns everything that only
 * matters while a turn / background run is live, so the persistent {@link Footer}
 * below the composer can stay a stable identity line:
 *
 *   ⠋ working · 47s · esc to interrupt        ← spinner + verb + elapsed timer
 *     └ bash: npm test                         ← live tool detail (≤ 3 lines)
 *     💬 btw ×2 · ◆ reviewer · ⧗ 1 bg          ← run-state chips
 *     • follow-up steer message…               ← visible steer queue
 *
 * Pure presenter except for the elapsed-time ticker, which — like {@link
 * WorkingIndicator} / {@link Mascot} — owns the only timer here and runs solely
 * while streaming (idle costs no ticks). The timer is never asserted in tests.
 */
import React, { useEffect, useState } from "react"
import { Box, Text, type DOMElement } from "ink"
import Spinner from "ink-spinner"

import { useTheme } from "../theme/context"
import { formatElapsed } from "../format/usage"
import { runningToolLines } from "../format/tools"
import { progressBar } from "../format/status-bar"
import { WorkingIndicator } from "./WorkingIndicator"
import type { ActivityState, ToolCell, TurnStatus } from "../state/types"

/** Display width of the steer-queue preview lines (per entry). */
const QUEUE_PREVIEW_MAX = 3

/** Silence (ms since the last stream delta) after which the stall hint shows.
 * Kept well below the sidecar's idle watchdog (`config.streamIdleTimeoutMs`,
 * default 60s) so the user is told "still waiting" before any timeout fires. */
const STALL_MS = 10_000

function truncate(text: string, max: number): string {
  if (max <= 0 || text.length <= max) return text
  return text.slice(0, Math.max(0, max - 1)) + "…"
}

function BottomStatusImpl({
  turnStatus,
  activity,
  tools = [],
  steerQueue = [],
  since,
  lastActivityAt,
  subagentRunning,
  backgroundSubagents = 0,
  interruptedBackgroundSubagents = 0,
  copilot,
  verbose = false,
  backtrackArmed = false,
  columns = 80,
  chipRowRef,
}: {
  turnStatus: TurnStatus
  activity?: ActivityState
  /** The current turn's still-resolving tool cells (`state.inflight.tools`). */
  tools?: ToolCell[]
  /** Pending `btw` steer messages awaiting the next turn boundary. */
  steerQueue?: string[]
  /** Timestamp (ms) the current turn entered "streaming", or null when idle. */
  since?: number | null
  /** Timestamp (ms) of the last live stream delta, or null when idle. Drives the
   * stall hint when the stream goes silent past {@link STALL_MS}. */
  lastActivityAt?: number | null
  /** The sub-agent dispatches running in the current turn. */
  subagentRunning?: { name: string; count: number } | null
  /** Detached background subagent runs still in flight. */
  backgroundSubagents?: number
  /** Detached background runs interrupted by a prior CLI exit. */
  interruptedBackgroundSubagents?: number
  /** Active Workflow Copilot draft, routing free-text to the copilot. */
  copilot?: { name: string } | null
  /** Detailed-output mode (Ctrl+O) is on. */
  verbose?: boolean
  /** Double-Esc backtrack is armed (idle) — show the confirm hint. */
  backtrackArmed?: boolean
  /** Terminal width, for tool-detail / queue-preview truncation. */
  columns?: number
  /** Ref on the run-state chip row so the App can hit-test a click on the
   * subagent chip and open the `/agents` panel. */
  chipRowRef?: React.Ref<DOMElement>
}) {
  const theme = useTheme()
  const busy = turnStatus !== "idle"
  const streaming = turnStatus === "streaming"

  // Elapsed-time ticker: only mounts while streaming, so an idle CLI never ticks.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!streaming || since == null) return
    const tick = () => setNow(Date.now())
    // Seed off the synchronous effect body (set-state-in-effect) so the baseline
    // re-syncs on (re)mount without a cascading render, then tick once a second.
    const seed = setTimeout(tick, 0)
    const id = setInterval(tick, 1000)
    return () => {
      clearTimeout(seed)
      clearInterval(id)
    }
  }, [streaming, since])
  const elapsed = since != null ? formatElapsed(now - since) : null

  // Stall hint: the stream has gone quiet (no delta for ≥ STALL_MS) while still
  // streaming. Reuses the same once-a-second `now` tick as the elapsed timer.
  const stalledMs = streaming && lastActivityAt != null ? Math.max(0, now - lastActivityAt) : 0
  const stalled = stalledMs >= STALL_MS

  const detailLines = runningToolLines(tools, columns, 3)

  // Run-state chips (everything transient — the persistent identity segments
  // stay in the Footer below the composer).
  const chips: React.ReactNode[] = []
  if (verbose)
    chips.push(
      <Text key="verbose" color={theme.accent}>
        detail
      </Text>
    )
  if (steerQueue.length > 0)
    chips.push(
      <Text key="steer" color={theme.secondary}>
        💬 btw×{steerQueue.length}
      </Text>
    )
  if (copilot)
    chips.push(
      <Text key="copilot" color={theme.info}>
        ⚙ copilot: {copilot.name} (/workflow exit)
      </Text>
    )
  if (subagentRunning)
    chips.push(
      <Text key="sub" color={theme.secondary}>
        ◆ {subagentRunning.name}
        {subagentRunning.count > 1 ? `×${subagentRunning.count}` : ""}
      </Text>
    )
  if (backgroundSubagents > 0)
    chips.push(
      <Text key="bg" color={theme.info}>
        ⧗ {backgroundSubagents} bg
      </Text>
    )
  if (interruptedBackgroundSubagents > 0)
    chips.push(
      <Text key="bgint" color={theme.warning}>
        ! {interruptedBackgroundSubagents} bg interrupted
      </Text>
    )

  const queuePreview = steerQueue.slice(0, QUEUE_PREVIEW_MAX)

  // Nothing live to show — render nothing. Detached background runs (and their
  // interrupted remnants) are persistent across turns, so they keep the layer
  // mounted even when the current turn is idle.
  if (
    !busy &&
    !activity &&
    steerQueue.length === 0 &&
    !backtrackArmed &&
    backgroundSubagents === 0 &&
    interruptedBackgroundSubagents === 0
  ) {
    return null
  }

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

      {busy ? (
        <Text color={theme.warning}>
          <Spinner type="dots" /> <WorkingIndicator turnStatus={turnStatus} />
          {elapsed ? ` · ${elapsed}` : ""} · esc to interrupt
        </Text>
      ) : null}

      {stalled ? (
        <Text color={theme.muted} dimColor>
          {"  ⏳ Waiting for API response · "}
          {formatElapsed(stalledMs)}
        </Text>
      ) : null}

      {detailLines.map((line, i) => (
        <Text key={`detail-${i}`} color={theme.muted} dimColor>
          {"  "}
          {line}
        </Text>
      ))}

      {chips.length > 0 ? (
        <Box ref={chipRowRef} flexShrink={0}>
          <Text wrap="wrap">
            {"  "}
            {chips.map((chip, i) => (
              <React.Fragment key={i}>
                {i > 0 ? <Text color={theme.muted}> · </Text> : null}
                {chip}
              </React.Fragment>
            ))}
          </Text>
        </Box>
      ) : null}

      {queuePreview.map((entry, i) => (
        <Text key={`q-${i}`} color={theme.muted} dimColor>
          {"  • "}
          {truncate(entry.replace(/\s+/g, " ").trim(), Math.max(8, columns - 4))}
        </Text>
      ))}

      {backtrackArmed && !busy ? (
        <Text color={theme.muted} dimColor>
          {"  esc again to edit last message"}
        </Text>
      ) : null}
    </Box>
  )
}

export const BottomStatus = React.memo(BottomStatusImpl)
