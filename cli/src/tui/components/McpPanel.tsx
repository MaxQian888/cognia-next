/**
 * Interactive `/mcp` panel: a live status board over the configured MCP servers.
 * Each row carries a coloured-bullet badge (connected / needs-auth / failed /
 * disabled) that lights up as the async probe resolves, plus an inline "how to
 * fix" affordance. Query/highlight live here (like {@link MarketplaceBrowser});
 * the parent owns the data and the per-row action callbacks.
 *
 * Keys: type to filter · ↑/↓ move · Enter runs the row's context action
 * (connected → tools · needs-auth → authorize · failed → reconnect · disabled →
 * enable) · Space toggles enable/disable · Ctrl+N adds a server · Ctrl+X removes
 * one · Esc clears the filter, then closes.
 */
import React, { useRef, useState } from "react"
import { Box, Text, type DOMElement } from "ink"
import { useModalInput } from "../input/input-router"
import { Spinner } from "./Spinner"

import { useTheme } from "../theme/context"
import { isMouseSequence } from "../input/mouse"
import { usePanelClick } from "../input/use-panel-click"
import { windowList } from "./list-window"
import { OverlayFooter } from "./OverlayFooter"
import {
  enterAction,
  filterMcpServers,
  fixHint,
  connectionIssueDetails,
  connectionIssueTitle,
  statusBadge,
  MCP_PANEL_FOOTER,
  type McpPanelServer,
} from "../runtime/mcp-panel-model"

const DEFAULT_MAX_ROWS = 8

export interface McpPanelProps {
  servers: McpPanelServer[]
  probing: boolean
  onTools: (name: string) => void
  onAuth: (name: string) => void
  onReconnect: (name: string) => void
  onToggle: (name: string) => void
  onAdd: () => void
  onRemove: (name: string) => void
  onCancel: () => void
  isActive?: boolean
  maxRows?: number
  width?: number | string
}

export function McpPanel({
  servers,
  probing,
  onTools,
  onAuth,
  onReconnect,
  onToggle,
  onAdd,
  onRemove,
  onCancel,
  isActive = true,
  maxRows = DEFAULT_MAX_ROWS,
  width,
}: McpPanelProps) {
  const theme = useTheme()
  const [query, setQuery] = useState("")
  const [index, setIndex] = useState(0)
  const boxRef = useRef<DOMElement | null>(null)

  const filtered = filterMcpServers(servers, query)
  const safeIndex = filtered.length > 0 ? Math.min(index, filtered.length - 1) : 0
  const current = filtered[safeIndex]
  const detailLines = current ? connectionIssueDetails(current) : []

  /** Run a server row's context action (shared by Enter and a click). */
  const activate = (s: McpPanelServer) => {
    switch (enterAction(s)) {
      case "tools":
        return onTools(s.name)
      case "auth":
        return onAuth(s.name)
      case "reconnect":
        return onReconnect(s.name)
      case "enable":
        return onToggle(s.name)
      case "none":
        return
    }
  }

  // Detail rows share the overlay's row budget with the server list. This keeps
  // a verbose stderr tail inside the panel instead of squeezing other regions.
  const listRows = Math.max(1, maxRows - (detailLines.length > 0 ? detailLines.length + 1 : 0))
  const win = windowList(filtered.length, safeIndex, listRows)
  const visible = filtered.slice(win.start, win.end)

  // Mouse (fullscreen `scroll` only): header = title + filter line (2 rows).
  const handleMouse = usePanelClick({
    boxRef,
    headerRows: 2,
    hasAboveMore: win.above > 0,
    visibleCount: visible.length,
    onPick: (offset) => {
      const target = filtered[win.start + offset]
      if (target) {
        setIndex(win.start + offset)
        activate(target)
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
        } else onCancel()
        return
      }
      if (key.ctrl && (input === "n" || input === "N")) return onAdd()
      if (key.ctrl && (input === "x" || input === "X")) {
        if (current) onRemove(current.name)
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
      // Space toggles enable/disable (taken before the printable branch so it
      // never lands in the filter).
      if (input === " ") {
        if (current) onToggle(current.name)
        return
      }
      if (key.return) {
        if (current) activate(current)
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
        MCP servers · {servers.length}
        {probing ? (
          <Text color={theme.info}>
            {"  "}
            <Spinner /> probing…
          </Text>
        ) : null}
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
          {visible.map((s, i) => {
            const row = win.start + i
            const selected = row === safeIndex
            const badge = statusBadge(s)
            const hint = fixHint(s)
            return (
              <Text key={s.name} color={selected ? theme.accent : undefined} bold={selected}>
                {selected ? "❯ " : "  "}
                <Text color={theme[badge.token]}>{badge.glyph}</Text> {s.name}
                <Text color={theme.muted}>
                  {" "}
                  · {s.transport}
                  {hint ? ` · ${hint}` : ""}
                </Text>
              </Text>
            )
          })}
          {win.below > 0 ? (
            <Text color={theme.muted} dimColor>{`  ↓ ${win.below} more`}</Text>
          ) : null}
        </>
      )}
      {current && detailLines.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={current.status === "needs_auth" ? theme.warning : theme.danger}>
            {connectionIssueTitle(current)}
          </Text>
          {detailLines.map((line, i) => (
            <Text key={`${current.name}-detail-${i}`} color={theme.muted} wrap="truncate-end">
              {i === 0 ? "  " : "  ↳ "}
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
      <OverlayFooter hint={MCP_PANEL_FOOTER} />
    </Box>
  )
}
