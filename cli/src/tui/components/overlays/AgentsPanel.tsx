/**
 * Interactive `/agents` panel (default Ctrl+B): a live board of the sub-agents
 * running right now — in-turn dispatches plus background runs (live + settled /
 * interrupted from the journal). Each row carries a coloured status bullet;
 * Enter opens a settled background run's output in the document pager, Esc
 * closes. Self-contained index (mirrors {@link McpPanel}); the parent owns the
 * rows + the view/cancel callbacks.
 */
import React, { useEffect, useRef, useState } from "react"
import { Box, Text, useInput, type DOMElement } from "ink"

import { useTheme } from "../../theme/context"
import { windowList } from "../list-window"
import { OverlayFooter } from "../OverlayFooter"
import { usePanelClick } from "../../input/use-panel-click"
import {
  agentRowBadge,
  agentRowHint,
  agentSummary,
  AGENTS_PANEL_FOOTER,
  type AgentPanelRow,
} from "../../runtime/agents-panel-model"

const DEFAULT_MAX_ROWS = 10

export interface AgentsPanelProps {
  rows: AgentPanelRow[]
  /** Open a row's output (settled background runs). */
  onView: (row: AgentPanelRow) => void
  onCancel: () => void
  /** Re-read the rows from the live sources — called on the 1s tick so the
   * board moves (status / tokens / tool counts) while it is open. */
  refresh?: () => AgentPanelRow[]
  /** Wall clock for elapsed text; injectable so tests stay deterministic. */
  now?: number
  isActive?: boolean
  maxRows?: number
  width?: number | string
}

export function AgentsPanel({
  rows: rowsProp,
  onView,
  onCancel,
  refresh,
  now: nowProp,
  isActive = true,
  maxRows = DEFAULT_MAX_ROWS,
  width,
}: AgentsPanelProps): React.ReactElement {
  const theme = useTheme()
  const [index, setIndex] = useState(0)
  const boxRef = useRef<DOMElement | null>(null)
  // Self-ticking wall clock for elapsed text when uncontrolled; a provided `now`
  // pins it for deterministic tests (and skips the timer). Date.now() must be
  // read in a state initializer / effect — not during render (react-hooks/purity,
  // mirrors BottomStatus).
  const [tickNow, setTickNow] = useState(() => Date.now())
  useEffect(() => {
    if (nowProp !== undefined) return
    const id = setInterval(() => setTickNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [nowProp])
  const now = nowProp ?? tickNow

  // Live board: re-read the rows alongside the clock tick so a run that settles
  // (or spends tokens) while the panel is open updates in place. The snapshot
  // from open time is the fallback when no refresher is supplied.
  const [liveRows, setLiveRows] = useState<AgentPanelRow[] | null>(null)
  useEffect(() => {
    if (!refresh) return
    const id = setInterval(() => setLiveRows(refresh()), 1000)
    return () => clearInterval(id)
  }, [refresh])
  const rows = liveRows ?? rowsProp

  const safeIndex = rows.length > 0 ? Math.min(index, rows.length - 1) : 0
  const current = rows[safeIndex]

  const summary = agentSummary(rows)
  const win = windowList(rows.length, safeIndex, maxRows)
  const visible = rows.slice(win.start, win.end)

  // Mouse (only reported in `scroll` mouse mode): wheel moves the selection; a
  // left-click on a row selects AND opens it (single click, like Claude Code).
  // The header line (`Agents · …`) is 1 row above the items.
  const handleMouse = usePanelClick({
    boxRef,
    headerRows: 1,
    hasAboveMore: win.above > 0,
    visibleCount: visible.length,
    onPick: (offset) => {
      const target = rows[win.start + offset]
      if (target) {
        setIndex(() => win.start + offset)
        onView(target)
      }
    },
    onWheel: (dir) =>
      setIndex(() =>
        dir === "up" ? Math.max(0, safeIndex - 1) : Math.min(rows.length - 1, safeIndex + 1)
      ),
  })

  useInput(
    (input, key) => {
      if (handleMouse(input)) return
      if (key.escape) return onCancel()
      if (key.upArrow) {
        setIndex(() => Math.max(0, safeIndex - 1))
        return
      }
      if (key.downArrow) {
        setIndex(() => Math.min(rows.length - 1, safeIndex + 1))
        return
      }
      if (key.return) {
        if (current) onView(current)
        return
      }
    },
    { isActive }
  )

  return (
    <Box
      ref={boxRef}
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
      width={width}
    >
      <Text bold>
        Agents · running {summary.running} · settled {summary.settled}
      </Text>
      {rows.length === 0 ? (
        <Text color={theme.muted} dimColor>
          {"  "}no sub-agents running or recorded
        </Text>
      ) : (
        <>
          {win.above > 0 ? (
            <Text color={theme.muted} dimColor>{`  ↑ ${win.above} more`}</Text>
          ) : null}
          {visible.map((agentRow, i) => {
            const row = win.start + i
            const selected = row === safeIndex
            const badge = agentRowBadge(agentRow.status)
            const task = agentRow.task ? agentRow.task.replace(/\s+/g, " ").slice(0, 60) : ""
            return (
              <Text key={agentRow.id} color={selected ? theme.accent : undefined} bold={selected}>
                {selected ? "❯ " : "  "}
                <Text color={theme[badge.token]}>{badge.glyph}</Text> {agentRow.name}
                <Text color={theme.muted}>
                  {" "}
                  · {agentRowHint(agentRow, now)}
                  {task ? ` · ${task}` : ""}
                </Text>
              </Text>
            )
          })}
          {win.below > 0 ? (
            <Text color={theme.muted} dimColor>{`  ↓ ${win.below} more`}</Text>
          ) : null}
        </>
      )}
      <OverlayFooter hint={AGENTS_PANEL_FOOTER} />
    </Box>
  )
}
