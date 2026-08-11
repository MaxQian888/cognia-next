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
import React, { useEffect, useRef, useState } from "react"
import { Box, Text, type DOMElement } from "ink"
import Spinner from "ink-spinner"

import { useTheme } from "../theme/context"
import { formatElapsed } from "../format/usage"
import { runningToolLines } from "../format/tools"
import { progressBar } from "../format/status-bar"
import { WorkingIndicator } from "./WorkingIndicator"
import { buildLiveAgentTreeRows, type LiveAgentTreeRow } from "../runtime/agents-panel-model"
import { listLiveSubagents, type SubagentLiveEntry } from "../../agent/subagent-live-output"
import type { ActivityState, ToolCell, TurnStatus } from "../state/types"

/** Display width of the steer-queue preview lines (per entry). */
const QUEUE_PREVIEW_MAX = 3

/** Max agents listed in the running-agents tree; the rest fold into one line. */
const TREE_MAX_AGENTS = 6

/** Poll cadence (ms) for the live-agents tree while runs are in flight. */
const TREE_POLL_MS = 1000

/**
 * What the App-level mouse handler needs to hit-test a click on the tree: the
 * rendered box plus the agents in display order. Published via `agentTreeRef`
 * after every render; `null` while the tree is not on screen.
 */
export interface AgentTreeHit {
  box: DOMElement | null
  agents: Array<{ liveId: string; name: string; task: string }>
}

/**
 * Resolve a click's row offset inside the tree box: the header opens the
 * agents panel, each agent spans two rows (stats + activity) and opens its run
 * page, the trailing "+N more" line falls back to the panel.
 */
export function agentTreeRowTarget(
  offset: number,
  agentCount: number
): number | "header" | "more" | null {
  if (offset < 0) return null
  if (offset === 0) return "header"
  const index = Math.floor((offset - 1) / 2)
  return index < agentCount ? index : "more"
}

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
  sessionId,
  getLiveEntries = listLiveSubagents,
  agentTreeRef,
  suppressAgentTree = false,
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
  /** The chat session — scopes the live-agents tree to this session's runs. */
  sessionId?: string
  /** Live-output reader (defaults to the store); injectable for tests. */
  getLiveEntries?: (owner?: string) => SubagentLiveEntry[]
  /** Published hit-test state for clicks on the running-agents tree. */
  agentTreeRef?: React.MutableRefObject<AgentTreeHit | null>
  /** A modal agents panel already owns this information; keep the turn status
   * visible there without painting a duplicate live tree underneath it. */
  suppressAgentTree?: boolean
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

  // ── Running-agents tree (Claude Code's `Running N agents…` block) ──────────
  // The live store mutates without re-rendering the App (a dispatching turn is
  // silent while its subagents stream), so the tree polls the store itself while
  // anything could be running, and stops once it drains.
  const [treeRows, setTreeRows] = useState<LiveAgentTreeRow[]>([])
  const treeBoxRef = useRef<DOMElement | null>(null)
  const treeSigRef = useRef("")
  const treePolling = busy || backgroundSubagents > 0 || treeRows.length > 0
  useEffect(() => {
    if (!treePolling) return
    const read = () => {
      const rows = buildLiveAgentTreeRows(getLiveEntries(sessionId))
      const sig = rows
        .map((r) => `${r.liveId} ${r.depth} ${r.name} ${r.stats} ${r.activity}`)
        .join("\n")
      if (sig === treeSigRef.current) return
      treeSigRef.current = sig
      setTreeRows(rows)
    }
    const seed = setTimeout(read, 0)
    const id = setInterval(read, TREE_POLL_MS)
    return () => {
      clearTimeout(seed)
      clearInterval(id)
    }
  }, [treePolling, sessionId, getLiveEntries])
  const visibleTree = React.useMemo(
    () => (suppressAgentTree ? [] : treeRows.slice(0, TREE_MAX_AGENTS)),
    [suppressAgentTree, treeRows]
  )
  const hiddenTree = treeRows.length - visibleTree.length

  // Publish the hit-test state for the App-level mouse handler. Written in an
  // effect (not during render) so it never trips the refs-during-render rule.
  useEffect(() => {
    if (!agentTreeRef) return
    agentTreeRef.current =
      visibleTree.length > 0
        ? {
            box: treeBoxRef.current,
            agents: visibleTree.map((r) => ({ liveId: r.liveId, name: r.name, task: r.task })),
          }
        : null
    return () => {
      agentTreeRef.current = null
    }
  }, [agentTreeRef, visibleTree])

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
  // The coarse `◆ name×N` chip is the fallback for dispatch channels that
  // bypass the live-output store — the tree above already covers the rest.
  if (subagentRunning && treeRows.length === 0)
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
    interruptedBackgroundSubagents === 0 &&
    treeRows.length === 0
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

      {visibleTree.length > 0 ? (
        <Box ref={treeBoxRef} flexDirection="column" flexShrink={0}>
          <Text color={theme.secondary}>
            Running {treeRows.length} agent{treeRows.length === 1 ? "" : "s"}…{" "}
            <Text color={theme.muted} dimColor>
              (ctrl+b to manage · click a row to watch)
            </Text>
          </Text>
          {visibleTree.map((row, i) => {
            const last = i === visibleTree.length - 1 && hiddenTree === 0
            const branch = last ? "└" : "├"
            const cont = last ? " " : "│"
            // Nested dispatches (a subagent's own subagents) indent under their
            // parent row — `depth` comes from the live store's parent edges.
            const indent = "  ".repeat(row.depth)
            return (
              <Box key={row.liveId} flexDirection="column">
                <Text wrap="truncate-end">
                  {" "}
                  <Text color={theme.muted}>
                    {indent}
                    {branch}
                  </Text>{" "}
                  <Text color={theme.accent} bold>
                    {row.name}
                  </Text>
                  <Text color={theme.muted}>
                    {" · "}
                    {row.stats}
                  </Text>
                </Text>
                <Text wrap="truncate-end" color={theme.muted} dimColor>
                  {" "}
                  {indent}
                  {cont}
                  {"  ⎿ "}
                  {row.activity}
                </Text>
              </Box>
            )
          })}
          {hiddenTree > 0 ? (
            <Text color={theme.muted} dimColor>
              {" └ … "}
              {hiddenTree} more — ctrl+b
            </Text>
          ) : null}
        </Box>
      ) : null}

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
