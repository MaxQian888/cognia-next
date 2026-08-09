/**
 * Unified `/logs` panel: a scrollable, filterable view over every captured log
 * channel — external agents, the sidecar, turn errors, plus a read-time
 * projection of the MCP buffer. New lines stream in live while it's open;
 * `follow` keeps the view pinned to the newest row until the user scrolls.
 *
 * Keys: type to filter · ↑/↓ + PgUp/PgDn scroll (drops follow) · Tab cycles the
 * level filter · ⇧Tab cycles the channel filter · Enter injects the selected row
 * into the composer · ^A injects everything currently shown · ^F toggles follow ·
 * ^L clears · ^Y copies · Esc clears the filter, then closes.
 *
 * View controls (query / filters / follow / cursor) are LOCAL state — a
 * keystroke must never round-trip through the reducer. The parent owns the
 * buffer and the clear/copy/close/inject effects.
 */
import React, { useMemo, useRef, useState } from "react"
import { Box, Text, type DOMElement } from "ink"
import { useModalInput } from "../input/input-router"

import { useTheme } from "../theme/context"
import { isMouseSequence } from "../input/mouse"
import { usePanelClick } from "../input/use-panel-click"
import { windowList } from "./list-window"
import { logPanelItemRows } from "./overlay-layout"
import { OverlayFooter } from "./OverlayFooter"
import { levelLabel, levelToken, formatLogTime } from "../runtime/mcp-log-model"
import {
  channelLabel,
  describeLogFilter,
  filterLogs,
  formatLogsForCopy,
  logCounts,
  nextChannelFilter,
  nextLevelFilter,
  LOG_PANEL_FOOTER_ACTIONS,
  LOG_PANEL_FOOTER_KEYS,
  type LogChannelFilter,
  type LogFilter,
  type LogLevelFilter,
} from "../runtime/log-model"
import type { LogEntry } from "../state/types"

const DEFAULT_MAX_ROWS = 12

export interface LogPanelProps {
  /**
   * The merged, bounded buffer (oldest→newest). MUST be a stable reference
   * between renders — passing an inline `state.logs.filter(...)` here would
   * defeat every memo below.
   */
  entries: LogEntry[]
  /** Empty the unified buffer (the ^L action). */
  onClear: () => void
  /** Copy the given text to the clipboard (parent wires `copyToClipboard`). */
  onCopy: (text: string) => void
  /**
   * Inject rows into the composer. The panel hands up ENTRIES plus a human
   * scope string; the host owns formatting, paste-collapse and — critically —
   * the dispatch ORDER (see `logInjectionActions`).
   */
  onInject: (rows: LogEntry[], scope: string) => void
  onClose: () => void
  isActive?: boolean
  /** The SHARED overlay budget from App. The panel subtracts its own extra
   *  chrome via `logPanelItemRows` before windowing. */
  maxRows?: number
  width?: number | string
}

export function LogPanel({
  entries,
  onClear,
  onCopy,
  onInject,
  onClose,
  isActive = true,
  maxRows = DEFAULT_MAX_ROWS,
  width,
}: LogPanelProps) {
  const theme = useTheme()
  const [query, setQuery] = useState("")
  const [level, setLevel] = useState<LogLevelFilter>("all")
  const [channel, setChannel] = useState<LogChannelFilter>("all")
  const [follow, setFollow] = useState(true)
  const [index, setIndex] = useState(0)
  const boxRef = useRef<DOMElement | null>(null)

  // Stable filter identity — rebuilding this inline inside the deps below would
  // make `filtered` miss on every single render.
  const filter = useMemo<LogFilter>(() => ({ query, level, channel }), [query, level, channel])
  const filtered = useMemo(() => filterLogs(entries, filter), [entries, filter])
  // Filter-INDEPENDENT on purpose: depending on `filter` would re-walk the whole
  // buffer on every keystroke of the query.
  const counts = useMemo(() => logCounts(entries), [entries])

  const lastRow = Math.max(0, filtered.length - 1)
  const selected = follow ? lastRow : Math.min(index, lastRow)

  const itemRows = logPanelItemRows(maxRows)
  const win = windowList(filtered.length, selected, itemRows)
  const visible = filtered.slice(win.start, win.end)

  const scrollTo = (next: number) => {
    const clamped = Math.max(0, Math.min(next, lastRow))
    setIndex(clamped)
    setFollow(clamped >= lastRow)
  }

  const scope = describeLogFilter(filter, counts.total, filtered.length)
  const inject = (rows: LogEntry[]) => {
    if (rows.length === 0) return
    onInject(rows, scope)
  }

  const handleMouse = usePanelClick({
    boxRef,
    // title + channel chips + filter. One more than `McpLogPanel`, which has no
    // chips row — an off-by-one here mis-maps every click.
    headerRows: 3,
    hasAboveMore: win.above > 0,
    visibleCount: visible.length,
    // Click SELECTS; it never injects. A click that fires a mutation is too
    // destructive for a panel whose rows are mostly noise.
    onPick: (offset) => scrollTo(win.start + offset),
    onWheel: (dir) => scrollTo(dir === "up" ? selected - 1 : selected + 1),
  })

  useModalInput(
    (input, key) => {
      if (handleMouse(input)) return
      if (key.escape) {
        if (query) setQuery("")
        else onClose()
        return
      }
      if (key.tab) {
        if (key.shift) setChannel((c) => nextChannelFilter(c, entries))
        else setLevel(nextLevelFilter)
        return
      }
      // Handled BEFORE the printable fallback below. `McpLogPanel` omits this
      // and so appends a stray "\r" to its query whenever Enter is pressed.
      if (key.return) {
        const row = filtered[selected]
        if (row) inject([row])
        return
      }
      if (key.ctrl && (input === "a" || input === "A")) {
        inject(filtered)
        return
      }
      if (key.ctrl && (input === "f" || input === "F")) {
        setFollow((f) => {
          if (!f) setIndex(lastRow)
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
      if (key.pageUp) {
        scrollTo(selected - itemRows)
        return
      }
      if (key.pageDown) {
        scrollTo(selected + itemRows)
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

  const chips = (["mcp", "agent", "sidecar", "system"] as const)
    .filter((c) => counts.channels[c] > 0)
    .map((c) => `${c} ${counts.channels[c]}`)
    .join(" · ")

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
        Logs · {counts.total}
        <Text color={theme.muted}>{"  "}</Text>
        {counts.levels.error > 0 ? (
          <Text color={theme.danger}>{counts.levels.error} err </Text>
        ) : null}
        {counts.levels.warn > 0 ? (
          <Text color={theme.warning}>{counts.levels.warn} warn </Text>
        ) : null}
        {follow ? <Text color={theme.info}>· following</Text> : null}
      </Text>
      <Text color={theme.muted} dimColor wrap="truncate-end">
        {chips || "no channels yet"}
      </Text>
      <Text>
        <Text color={theme.muted}>filter: </Text>
        {query ? (
          <Text>{query}</Text>
        ) : (
          <Text color={theme.muted} dimColor>
            {scope}
          </Text>
        )}
      </Text>
      {counts.total === 0 ? (
        <Text color={theme.muted} dimColor>
          {"  "}no logs captured yet — they appear as agents, MCP servers, and the backend emit
          output
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
                <Text color={theme.muted}>{channelLabel(l)} </Text>
                <Text>{l.message}</Text>
              </Text>
            )
          })}
          {win.below > 0 ? (
            <Text color={theme.muted} dimColor>{`  ↓ ${win.below} more`}</Text>
          ) : null}
        </>
      )}
      <OverlayFooter hint={LOG_PANEL_FOOTER_KEYS} />
      <OverlayFooter hint={LOG_PANEL_FOOTER_ACTIONS} />
    </Box>
  )
}
