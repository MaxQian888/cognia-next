/**
 * The live "agent run page" — switch into one sub-agent's run and watch its
 * streamed reasoning, tool activity, and reply text token-by-token (Claude
 * Code's subagent transcript). Opened from the `/agents` panel (Enter / click a
 * running row) or by clicking a row in the BottomStatus running-agents tree.
 *
 * Content is read live from the {@link subagent-live-output} store by `liveId`:
 * while the run is `running` the page polls the store on a short interval and
 * re-renders as the entry's `version` grows; once settled it stops polling. The
 * body is the entry's chronological `timeline` — thinking, tool calls (with a
 * one-line input summary), and reply text interleaved in the order they
 * happened — and follows the tail while streaming (scroll up to pin; scrolling
 * back to the bottom re-engages follow). The body scrolls with the shared
 * {@link usePanelScroll} viewport (↑/↓ · PgUp/PgDn · wheel); Esc closes.
 * Wall-clock + store reads are injectable so it unit-tests without timers or a
 * sidecar.
 */
import React from "react"
import { Box, Text, type Key } from "ink"
import { useModalInput } from "../../input/input-router"

import {
  PANEL_CHROME_ROWS,
  PanelViewport,
  panelFooterHint,
  usePanelScroll,
} from "../../hooks/usePanelScroll"
import { useTheme } from "../../theme/context"
import { parseMouseEvent } from "../../input/mouse"
import { toolDisplayName } from "../../format/tools"
import { contentRows } from "../../layout/terminal-layout"
import { panelColumns } from "../overlay-layout"
import { truncateToWidth } from "../../markdown/width"
import {
  agentRowBadge,
  formatElapsed,
  formatTokenCount,
  type AgentRowStatus,
} from "../../runtime/agents-panel-model"
import {
  getLiveSubagent,
  liveTokenCount,
  type SubagentLiveEntry,
  type SubagentTimelineSegment,
} from "../../../agent/subagent-live-output"

export interface AgentRunPageProps {
  liveId: string
  name: string
  task: string
  /** Read the live entry (defaults to the store); App binds it to the owner session. */
  getEntry?: (liveId: string) => SubagentLiveEntry | undefined
  onClose: () => void
  onStopTask?: (taskId: string) => void
  /** Wall clock for elapsed text; injectable so tests stay deterministic. */
  now?: number
  isActive?: boolean
  width?: number | string
  /** Test seam: viewport height in rows (defaults to the terminal height). */
  viewportRows?: number
  /** Poll cadence while the run is in flight. */
  pollMs?: number
}

/** A minimal Ink `Key` with just the field the scroll controller reads. */
function scrollKey(field: "upArrow" | "downArrow"): Key {
  return { [field]: true } as unknown as Key
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`
}

/** One timeline segment, rendered in transcript order with enough context to
 * understand what happened without opening a second inspector. */
function TimelineSegment({
  segment,
  runStartedAt,
  now,
}: {
  segment: SubagentTimelineSegment
  runStartedAt?: number
  now: number
}) {
  const theme = useTheme()
  if (segment.kind === "thinking") {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color={theme.secondary}>◇ Reasoning</Text>
        <Text color={theme.muted} dimColor>
          {"  "}
          {segment.text}
        </Text>
      </Box>
    )
  }
  if (segment.kind === "text") {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color={theme.info}>● Response</Text>
        <Text>
          {"  "}
          {segment.text}
        </Text>
      </Box>
    )
  }
  const badge = agentRowBadge(segment.status)
  const timing: string[] = [segment.status]
  if (runStartedAt !== undefined && segment.startedAt !== undefined) {
    timing.push(`+${formatElapsed(segment.startedAt - runStartedAt)}`)
  }
  if (segment.startedAt !== undefined) {
    timing.push(formatElapsed((segment.settledAt ?? now) - segment.startedAt))
  }
  const resultMeta: string[] = []
  if (segment.resultLines !== undefined) resultMeta.push(countLabel(segment.resultLines, "line"))
  if (segment.resultChars !== undefined) resultMeta.push(countLabel(segment.resultChars, "char"))
  if (segment.resultPreview) resultMeta.push(segment.resultPreview)
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={theme[badge.token]}>{badge.glyph}</Text>{" "}
        <Text color={theme.accent}>{toolDisplayName(segment.name)}</Text>
        <Text color={theme.muted}> · {timing.join(" · ")}</Text>
      </Text>
      <Text color={theme.muted} dimColor>
        {"  input · "}
        {segment.summary || "arguments not captured"}
      </Text>
      {resultMeta.length > 0 ? (
        <Text color={segment.status === "error" ? theme.danger : theme.muted} dimColor>
          {"  result · "}
          {resultMeta.join(" · ")}
        </Text>
      ) : segment.status === "running" ? (
        <Text color={theme.muted} dimColor>
          {"  result · awaiting tool completion"}
        </Text>
      ) : null}
    </Box>
  )
}

/** Border, padding and the "Task \u00b7 " prefix the task line spends before
 * its own text. The line has to fit one terminal row: it sits above the
 * scrolling viewport, whose height is budgeted assuming the header is fixed. */
const TASK_CHROME = 11

export function AgentRunPage({
  liveId,
  name,
  task,
  getEntry = getLiveSubagent,
  onClose,
  onStopTask,
  now: nowProp,
  isActive = true,
  width,
  viewportRows,
  pollMs = 300,
}: AgentRunPageProps): React.ReactElement {
  const theme = useTheme()
  const viewport = Math.max(1, contentRows(viewportRows ?? 24, PANEL_CHROME_ROWS))
  // Follow the tail while the run streams (Claude Code behaviour); scrolling up
  // disengages the pin, scrolling back to the bottom re-engages it.
  const scroll = usePanelScroll(viewport, { top: 0, stick: true })
  const [, setTick] = React.useState(0)
  // Self-ticking wall clock for elapsed text when uncontrolled; a provided `now`
  // pins it for deterministic tests. Date.now() must be read in a state
  // initializer / effect — not during render (react-hooks/purity).
  const [nowTick, setNowTick] = React.useState(() => Date.now())
  const now = nowProp ?? nowTick

  const entry = getEntry(liveId)
  const status: AgentRowStatus = entry?.status ?? "running"

  // Poll the live store while the run is in flight; stop once it settles.
  React.useEffect(() => {
    if (!isActive || status !== "running") return
    const handle = setInterval(() => {
      setTick((t) => t + 1)
      // Advance the elapsed clock alongside the poll when uncontrolled.
      if (nowProp === undefined) setNowTick(Date.now())
    }, pollMs)
    return () => clearInterval(handle)
  }, [isActive, status, pollMs, liveId, getEntry, nowProp])

  useModalInput(
    (input, key) => {
      if (key.escape || key.return) return onClose()
      if (input.toLowerCase() === "s" && status === "running" && entry?.runtimeTaskId) {
        onStopTask?.(entry.runtimeTaskId)
        return
      }
      const mouse = parseMouseEvent(input)
      if (mouse) {
        if (mouse.kind === "wheel")
          scroll.onKey("", scrollKey(mouse.dir === "up" ? "upArrow" : "downArrow"))
        return
      }
      scroll.onKey(input, key)
    },
    { isActive }
  )

  const badge = agentRowBadge(status)
  const elapsed =
    entry?.startedAt !== undefined
      ? formatElapsed((entry.settledAt ?? now) - entry.startedAt)
      : null
  const tokens = entry ? liveTokenCount(entry) : null
  const statsParts: string[] = [status]
  if (elapsed) statsParts.push(elapsed)
  if (entry && entry.toolUseCount > 0)
    statsParts.push(`${entry.toolUseCount} tool use${entry.toolUseCount === 1 ? "" : "s"}`)
  if (tokens && tokens.tokens > 0)
    statsParts.push(`${tokens.exact ? "" : "~"}${formatTokenCount(tokens.tokens)} tokens`)
  const timeline = entry?.timeline ?? []

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
      width={width}
    >
      <Text bold>
        Agent · <Text color={theme[badge.token]}>{badge.glyph}</Text> {name}
        <Text color={theme.muted}> · {statsParts.join(" · ")}</Text>
      </Text>
      {task ? (
        <Text color={theme.muted} dimColor>
          Task ·{" "}
          {truncateToWidth(task.replace(/\s+/g, " ").trim(), panelColumns(width) - TASK_CHROME)}
        </Text>
      ) : null}
      <PanelViewport viewportRows={viewport} scroll={scroll}>
        {!entry ? (
          <Text color={theme.muted} dimColor>
            no live output for this run.
          </Text>
        ) : timeline.length === 0 ? (
          <Text color={theme.muted} dimColor>
            waiting for first output…
          </Text>
        ) : (
          <>
            <Text color={theme.muted} dimColor>
              Timeline · {countLabel(timeline.length, "event")}
            </Text>
            {timeline.map((segment, i) => (
              <TimelineSegment
                key={segment.kind === "tool" && segment.id ? segment.id : i}
                segment={segment}
                runStartedAt={entry.startedAt}
                now={now}
              />
            ))}
          </>
        )}
      </PanelViewport>
      <Text color={theme.muted} dimColor>
        {panelFooterHint(scroll.hidden)}
        {status === "running" && entry?.runtimeTaskId ? " · s stop" : ""}
      </Text>
    </Box>
  )
}
