/**
 * Interactive `/mcp logs` panel: a scrollable, filterable view over the captured
 * MCP server output log (`state.mcpLogs` — the sidecar's `mcp_log` + generic
 * `log` stream). New lines stream in live while it's open; `follow` keeps the
 * view pinned to the newest row until the user scrolls.
 *
 * Keys: type to filter · ↑/↓ scroll (drops follow) · Tab cycles the level filter ·
 * ⇧Tab cycles the server filter · Ctrl+F toggles follow · Ctrl+L clears the
 * buffer · Ctrl+Y copies the visible lines · Esc clears the filter, then closes.
 *
 * View controls (query / filters / follow / cursor) are LOCAL state, like the
 * `mcp` panel — the parent owns only the log buffer + the clear/copy callbacks.
 */
import React, { useRef, useState } from "react"
import { Box, Text, useInput, type DOMElement } from "ink"

import { useTheme } from "../theme/context"
import { isMouseSequence } from "../input/mouse"
import { usePanelClick } from "../input/use-panel-click"
import { windowList } from "./list-window"
import { OverlayFooter } from "./OverlayFooter"
import {
  filterMcpLogs,
  levelToken,
  levelLabel,
  levelCounts,
  nextLevelFilter,
  nextServerFilter,
  formatLogTime,
  formatLogsForCopy,
  describeFilter,
  MCP_LOG_PANEL_FOOTER,
  type McpLogFilter,
} from "../runtime/mcp-log-model"
import type { McpLogEntry, McpLogLevel } from "../state/types"

const DEFAULT_MAX_ROWS = 12

export interface McpLogPanelProps {
  logs: McpLogEntry[]
  /** Empty the captured buffer (the `c`/Ctrl+L action). */
  onClear: () => void
  /** Copy the given text to the clipboard (parent wires `copyToClipboard`). */
  onCopy: (text: string) => void
  onClose: () => void
  /** Optional live server-status summary shown under the title. */
  statusSummary?: string
  isActive?: boolean
  maxRows?: number
  width?: number | string
}

export function McpLogPanel({
  logs,
  onClear,
  onCopy,
  onClose,
  statusSummary,
  isActive = true,
  maxRows = DEFAULT_MAX_ROWS,
  width,
}: McpLogPanelProps) {
  const theme = useTheme()
  const [query, setQuery] = useState("")
  const [level, setLevel] = useState<McpLogLevel | "all">("all")
  const [server, setServer] = useState<string | "all">("all")
  const [follow, setFollow] = useState(true)
  const [index, setIndex] = useState(0)
  const boxRef = useRef<DOMElement | null>(null)

  const filter: McpLogFilter = { query, level, server }
  const filtered = filterMcpLogs(logs, filter)
  const lastRow = Math.max(0, filtered.length - 1)
  // With follow on, the view is pinned to the newest row; otherwise the cursor
  // is the user's last scroll position (clamped as the buffer grows/shrinks).
  const selected = follow ? lastRow : Math.min(index, lastRow)
  const counts = levelCounts(logs)

  const win = windowList(filtered.length, selected, maxRows)
  const visible = filtered.slice(win.start, win.end)

  const scrollTo = (next: number) => {
    const clamped = Math.max(0, Math.min(next, lastRow))
    setIndex(clamped)
    // Re-engage follow only when the cursor lands on the newest row.
    setFollow(clamped >= lastRow)
  }

  // Mouse wheel scrolls (logs aren't row-actionable, so no click-to-pick).
  const handleMouse = usePanelClick({
    boxRef,
    headerRows: 2,
    hasAboveMore: win.above > 0,
    visibleCount: visible.length,
    onPick: () => undefined,
    onWheel: (dir) => scrollTo(dir === "up" ? selected - 1 : selected + 1),
  })

  useInput(
    (input, key) => {
      if (handleMouse(input)) return
      if (key.escape) {
        if (query) {
          setQuery("")
        } else onClose()
        return
      }
      // ⇧Tab cycles the server filter; Tab (alone) cycles the level filter.
      if (key.tab) {
        if (key.shift) setServer((s) => nextServerFilter(s, logs))
        else setLevel(nextLevelFilter)
        return
      }
      if (key.ctrl && (input === "f" || input === "F")) {
        setFollow((f) => {
          if (!f) setIndex(lastRow) // snap to newest when re-engaging
          return !f
        })
        return
      }
      if (key.ctrl && (input === "l" || input === "L")) {
        onClear()
        setIndex(0)
        setFollow(true)
        return
      }
      if (key.ctrl && (input === "y" || input === "Y")) {
        onCopy(formatLogsForCopy(filtered))
        return
      }
      if (key.upArrow) {
        scrollTo(selected - 1)
        return
      }
      if (key.downArrow) {
        scrollTo(selected + 1)
        return
      }
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1))
        return
      }
      if (input && !key.ctrl && !key.meta && !isMouseSequence(input)) {
        setQuery((q) => q + input)
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
        MCP logs · {logs.length}
        <Text color={theme.muted}>{"  "}</Text>
        {counts.error > 0 ? <Text color={theme.danger}>{counts.error} err </Text> : null}
        {counts.warn > 0 ? <Text color={theme.warning}>{counts.warn} warn </Text> : null}
        {follow ? <Text color={theme.info}>· following</Text> : null}
      </Text>
      {statusSummary ? (
        <Text color={theme.muted} dimColor>
          {statusSummary}
        </Text>
      ) : null}
      <Text>
        <Text color={theme.muted}>filter: </Text>
        {query ? (
          <Text>{query}</Text>
        ) : (
          <Text color={theme.muted} dimColor>
            {describeFilter(filter, logs.length, filtered.length)}
          </Text>
        )}
      </Text>
      {logs.length === 0 ? (
        <Text color={theme.muted} dimColor>
          {"  "}no MCP logs captured yet — they appear as servers start / emit output
        </Text>
      ) : filtered.length === 0 ? (
        <Text color={theme.muted} dimColor>
          {"  "}no matches
        </Text>
      ) : (
        <>
          {win.above > 0 ? (
            <Text color={theme.muted} dimColor>{`  ↑ ${win.above} more`}</Text>
          ) : null}
          {visible.map((l, i) => {
            const row = win.start + i
            const isSel = row === selected
            return (
              <Text key={l.id} wrap="truncate-end">
                <Text color={isSel ? theme.accent : undefined}>{isSel ? "❯ " : "  "}</Text>
                <Text color={theme.muted}>{formatLogTime(l.ts)} </Text>
                <Text color={theme[levelToken(l.level)]}>{levelLabel(l.level)} </Text>
                {l.server ? <Text color={theme.muted}>[{l.server}] </Text> : null}
                <Text>{l.message}</Text>
              </Text>
            )
          })}
          {win.below > 0 ? (
            <Text color={theme.muted} dimColor>{`  ↓ ${win.below} more`}</Text>
          ) : null}
        </>
      )}
      <OverlayFooter hint={MCP_LOG_PANEL_FOOTER} />
    </Box>
  )
}
