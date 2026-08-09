/**
 * Per-tool enable/disable list for one MCP server (drill-down from the `/mcp`
 * panel). Space toggles a tool — the parent persists it into the `disabledTools`
 * overlay, which `session-runner` unions into the model's `disallowedTools`, so a
 * disabled tool stops reaching the model on the next turn. Esc returns to the
 * server panel. The toggle state is owned here (seeded from props) so the row
 * flips instantly; the parent callback only persists.
 */
import React, { useRef, useState } from "react"
import { Box, Text, type DOMElement } from "ink"
import { useModalInput } from "../input/input-router"

import { useTheme } from "../theme/context"
import { isMouseSequence } from "../input/mouse"
import { usePanelClick } from "../input/use-panel-click"
import { windowList } from "./list-window"
import { OverlayFooter } from "./OverlayFooter"
import { filterMcpTools, MCP_TOOLS_FOOTER, type McpPanelTool } from "../runtime/mcp-panel-model"

const DEFAULT_MAX_ROWS = 10

export interface McpToolsPanelProps {
  server: string
  tools: McpPanelTool[]
  /** Persist one tool's new enabled state. */
  onToggle: (toolName: string, enabled: boolean) => void
  onBack: () => void
  isActive?: boolean
  maxRows?: number
  width?: number | string
}

export function McpToolsPanel({
  server,
  tools: initialTools,
  onToggle,
  onBack,
  isActive = true,
  maxRows = DEFAULT_MAX_ROWS,
  width,
}: McpToolsPanelProps) {
  const theme = useTheme()
  const [tools, setTools] = useState(initialTools)
  const [query, setQuery] = useState("")
  const [index, setIndex] = useState(0)
  const boxRef = useRef<DOMElement | null>(null)

  const filtered = filterMcpTools(tools, query)
  const safeIndex = filtered.length > 0 ? Math.min(index, filtered.length - 1) : 0
  const enabledCount = tools.filter((t) => t.enabled).length

  /** Flip one tool's enabled state (shared by Space/Enter and a click). */
  const toggleTool = (t: McpPanelTool) => {
    const next = !t.enabled
    setTools((list) => list.map((x) => (x.name === t.name ? { ...x, enabled: next } : x)))
    onToggle(t.name, next)
  }

  const win = windowList(filtered.length, safeIndex, maxRows)
  const visible = filtered.slice(win.start, win.end)

  // Mouse (fullscreen `scroll` only): header = title + filter line (2 rows); a
  // click toggles the row (same as Space/Enter).
  const handleMouse = usePanelClick({
    boxRef,
    headerRows: 2,
    hasAboveMore: win.above > 0,
    visibleCount: visible.length,
    onPick: (offset) => {
      const target = filtered[win.start + offset]
      if (target) {
        setIndex(win.start + offset)
        toggleTool(target)
      }
    },
    onWheel: (dir) =>
      setIndex((i) =>
        dir === "up"
          ? Math.max(0, Math.min(i, filtered.length - 1) - 1)
          : Math.min(filtered.length - 1, i + 1)
      ),
  })

  useModalInput(
    (input, key) => {
      if (handleMouse(input)) return
      if (key.escape) {
        if (query) {
          setQuery("")
          setIndex(0)
        } else onBack()
        return
      }
      if (key.upArrow) {
        setIndex((i) => Math.max(0, Math.min(i, filtered.length - 1) - 1))
        return
      }
      if (key.downArrow) {
        setIndex((i) => Math.min(filtered.length - 1, i + 1))
        return
      }
      if (input === " " || key.return) {
        const t = filtered[safeIndex]
        if (t) toggleTool(t)
        return
      }
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1))
        setIndex(0)
        return
      }
      if (input && !key.ctrl && !key.meta && !isMouseSequence(input)) {
        setQuery((q) => q + input)
        setIndex(0)
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
        {server} · tools
        <Text color={theme.muted}>
          {"  "}
          {enabledCount}/{tools.length} enabled
        </Text>
      </Text>
      <Text>
        <Text color={theme.muted}>filter: </Text>
        {query ? (
          <Text>{query}</Text>
        ) : (
          <Text color={theme.muted} dimColor>
            (all)
          </Text>
        )}
      </Text>
      {filtered.length === 0 ? (
        <Text color={theme.muted} dimColor>
          {"  "}no matches
        </Text>
      ) : (
        <>
          {win.above > 0 ? (
            <Text color={theme.muted} dimColor>{`  ↑ ${win.above} more`}</Text>
          ) : null}
          {visible.map((t, i) => {
            const row = win.start + i
            const selected = row === safeIndex
            return (
              <Text key={t.name} color={selected ? theme.accent : undefined} bold={selected}>
                {selected ? "❯ " : "  "}
                <Text color={t.enabled ? theme.success : theme.muted}>
                  {t.enabled ? "●" : "○"}
                </Text>{" "}
                {t.name}
                {t.description ? <Text color={theme.muted}> — {t.description}</Text> : null}
              </Text>
            )
          })}
          {win.below > 0 ? (
            <Text color={theme.muted} dimColor>{`  ↓ ${win.below} more`}</Text>
          ) : null}
        </>
      )}
      <OverlayFooter hint={MCP_TOOLS_FOOTER} />
    </Box>
  )
}
