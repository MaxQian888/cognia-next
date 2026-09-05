/**
 * The single mutating region below the transcript that shows the current turn's
 * live reasoning, streaming answer, and running tool calls before they commit to
 * permanent cells.
 *
 * Reasoning is collapsed by default — just a `✻ Thinking…` indicator — so a long
 * chain-of-thought doesn't flood the terminal mid-turn. Tool cells stay live here
 * so status transitions (⏳→✓, ⏳→✗) re-render instantly; once a tool completes
 * it is moved to `<Static>` cells at the next commit boundary.
 */
import React from "react"
import { Box, Text } from "ink"

import { Markdown } from "./Markdown"
import { useTheme } from "../theme/context"
import { useRenderPrefs } from "../render/context"
import { usePacedReveal } from "../render/use-paced-reveal"
import type { Cell, Inflight as InflightState } from "../state/types"
import { CellView } from "./CellView"
import { groupContextRuns, contextGroupLines } from "../format/context-group"
import { toolDetailLine } from "../format/tools"
import { ThinkingPulse } from "./Spinner"

export function Inflight({
  inflight,
  pending = [],
  awaitingApproval = false,
  verbose = false,
  epoch,
  columns = 80,
}: {
  inflight: InflightState
  /**
   * Cells that arrived while this region had content on screen, painted under
   * it until the turn commits. They are the reason a notice about the third
   * tool call no longer appears above the first one's output.
   */
  pending?: readonly Cell[]
  /** Presentation only: the permission overlay owns whether the turn is waiting. */
  awaitingApproval?: boolean
  /** Detail mode (Ctrl+O): when on, the live reasoning text is shown in full. */
  verbose?: boolean
  /** Turn identity — restarts the paced reveal so a SHORT turn after a long one
   * animates from zero instead of inheriting the previous character count. */
  epoch?: number
  columns?: number
}) {
  const theme = useTheme()
  // Paced "typing" reveal of the live answer — only on an interactive TTY, and
  // opt-out via render prefs. Hooks run before the early return to keep order
  // stable. When disabled the hook returns the full text unchanged.
  const prefs = useRenderPrefs()
  const revealEnabled = prefs.streamReveal && Boolean(process.stdout.isTTY)
  const revealedText = usePacedReveal(
    inflight.text,
    revealEnabled,
    epoch === undefined ? {} : { epoch }
  )
  const hasThinking = inflight.thinking.length > 0
  const hasText = inflight.text.length > 0
  const hasTools = inflight.tools.length > 0
  if (!hasThinking && !hasText && !hasTools && pending.length === 0) return null
  const renderCell = (cell: Cell): React.ReactNode =>
    awaitingApproval && cell.kind === "tool" && cell.status === "running" ? (
      <Box key={cell.id} flexDirection="column">
        <Text color={theme.warning}>Waiting for approval</Text>
        <Text color={theme.muted}>{toolDetailLine(cell, columns)}</Text>
      </Box>
    ) : (
      <CellView
        key={cell.id}
        cell={
          verbose && (cell.kind === "tool" || cell.kind === "thinking")
            ? { ...cell, collapsed: false }
            : cell
        }
        columns={columns}
      />
    )
  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Tools come first, and the reducer commits them first too. Reasoning
          and answer text only sit here alongside a tool once that tool has
          already started, because a tool call flushes both — so anything below
          arrived after the cards above it. Painting reasoning on top (which is
          what this did) made every finished tool card jump over it the moment
          the turn committed. */}
      {hasTools && (
        <Box flexDirection="column" marginBottom={1}>
          {/* Settled context reads fold into one summary row here too. The
              transcript has always folded them once the turn committed, so a
              turn that opened twelve files showed twelve cards while it ran and
              one line the moment it finished. The live region is where the
              flood actually hurts: it is on screen while the reader is trying
              to follow what the agent is doing. */}
          {groupContextRuns(inflight.tools, verbose).map((run) =>
            run.kind === "group" ? (
              <Box key={`context:${run.tools[0].id}`} flexDirection="column">
                {contextGroupLines(run.tools, columns).map((line, index) => (
                  <Text key={index} color={index === 0 ? theme.statusDone : theme.text}>
                    {line}
                  </Text>
                ))}
              </Box>
            ) : (
              renderCell(run.cell)
            )
          )}
        </Box>
      )}
      {hasThinking && (
        <Box flexDirection="column">
          <Text>
            {awaitingApproval ? null : <ThinkingPulse />}
            <Text color={theme.thinking} italic>
              {" "}
              {awaitingApproval ? "Waiting for approval" : "Thinking…"}
            </Text>
            {!verbose && (
              <Text color={theme.muted} dimColor>
                {" "}
                ctrl+o to expand
              </Text>
            )}
          </Text>
          {verbose && (
            <Text color={theme.thinking} dimColor>
              {inflight.thinking}
            </Text>
          )}
        </Box>
      )}
      {hasText && <Markdown raw={revealedText} streaming columns={columns} />}
      {pending.map(renderCell)}
    </Box>
  )
}
