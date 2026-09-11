/**
 * MCP configuration and runtime inventory. Session evidence owns the primary
 * badge; short-lived Cognia connectivity probes are labelled independently.
 * Agent-native and internal bridge entries expose inspection only.
 */
import React, { useRef, useState } from "react"
import { Box, Text, type DOMElement } from "ink"
import { useModalInput } from "../input/input-router"
import { Spinner } from "./Spinner"
import { useCliTranslations, useCliLocale } from "../i18n"

import { useTheme } from "../theme/context"
import { isMouseSequence } from "../input/mouse"
import { usePanelClick } from "../input/use-panel-click"
import { windowListWithinRows } from "./list-window"
import { OVERLAY_CHROME_ROWS, panelColumns, wrappedRows } from "./overlay-layout"
import { OverlayFooter } from "./OverlayFooter"
import {
  enterAction,
  filterMcpServers,
  statusBadge,
  type McpPanelServer,
} from "../runtime/mcp-panel-model"

const DEFAULT_MAX_ROWS = 8

export interface McpPanelProps {
  servers: McpPanelServer[]
  probing: boolean
  runtimeBackend?: string
  onRefresh?: () => void
  onApply?: () => void
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
  runtimeBackend,
  onRefresh,
  onApply,
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
  const t = useCliTranslations("cliUiCommon")
  const locale = useCliLocale()
  const [query, setQuery] = useState("")
  const [index, setIndex] = useState(0)
  const boxRef = useRef<DOMElement | null>(null)

  const filtered = filterMcpServers(servers, query)
  const safeIndex = filtered.length > 0 ? Math.min(index, filtered.length - 1) : 0
  const current = filtered[safeIndex]
  const editable = (server: McpPanelServer) =>
    !server.readOnly && (!server.source || server.source === "cognia")
  const rowId = (server: McpPanelServer) => server.id ?? server.name
  const detailLines: string[] = []
  if (current) {
    if (current.sessionStatus && current.sessionScope !== "agent")
      detailLines.push(
        t("mcp.session", { status: t(`mcp.sessionStatus.${current.sessionStatus}`) })
      )
    if (current.sessionStatus && editable(current))
      detailLines.push(
        t("mcp.probe", {
          status: t(`mcp.probeStatus.${current.enabled ? current.status : "disabled"}`),
        })
      )
    if (current.sessionScope === "agent")
      detailLines.push(
        t("mcp.agentInventory", {
          status: t(`mcp.sessionStatus.${current.sessionStatus ?? "unknown"}`),
        })
      )
    if (current.conflict) detailLines.push(t("mcp.conflict", { detail: current.conflict }))
    if (current.sessionError)
      detailLines.push(t("mcp.sessionError", { error: current.sessionError }))
    if (editable(current) && current.enabled && current.status === "needs_auth")
      detailLines.push(t("mcp.authDetail", { transport: current.transport }))
    if (editable(current) && current.enabled && current.status === "failed") {
      const errors = (current.error ?? t("mcp.noError"))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-3)
      detailLines.push(
        t(errors.some((line) => /timed out|timeout/i.test(line)) ? "mcp.timeout" : "mcp.failed", {
          transport: current.transport,
        }),
        ...errors
      )
    }
    if (current.probedAt)
      detailLines.push(
        t("mcp.probeTime", { time: new Date(current.probedAt).toLocaleTimeString(locale) })
      )
  }
  const hintFor = (server: McpPanelServer): string | null => {
    if (!editable(server))
      return server.sessionStatus === "available"
        ? t("mcp.runtimeTools", { count: server.sessionToolCount ?? 0 })
        : t("mcp.readonly")
    switch (enterAction(server)) {
      case "tools":
        return server.toolCount == null
          ? t("mcp.toolsAction")
          : t("mcp.tools", { count: server.toolCount })
      case "auth":
        return t("mcp.auth")
      case "reconnect":
        return t("mcp.reconnect")
      case "enable":
        return t("mcp.enable")
      default:
        return null
    }
  }

  /** Run a server row's context action (shared by Enter and a click). */
  const activate = (s: McpPanelServer) => {
    switch (enterAction(s)) {
      case "tools":
        return onTools(rowId(s))
      case "auth":
        return onAuth(rowId(s))
      case "reconnect":
        return onReconnect(rowId(s))
      case "enable":
        return onToggle(rowId(s))
      case "none":
        return
    }
  }

  // Detail rows share the overlay's row budget with the server list. This keeps
  // a verbose stderr tail inside the panel instead of squeezing other regions.
  const scopeText = runtimeBackend
    ? t("mcp.scope", { backend: runtimeBackend })
    : t("mcp.localScope")
  const innerWidth = Math.max(1, panelColumns(width) - 4)
  const fixedRows =
    4 +
    wrappedRows(t("mcp.footer"), innerWidth) +
    wrappedRows(scopeText, innerWidth) +
    (onApply || onRefresh ? wrappedRows(t("mcp.sessionFooter"), innerWidth) : 0)
  const bodyRows = Math.max(1, maxRows + OVERLAY_CHROME_ROWS - fixedRows)
  const shownDetails = detailLines.slice(0, Math.max(0, bodyRows - 4))
  const listRows = Math.max(1, bodyRows - (shownDetails.length ? shownDetails.length + 2 : 0))
  const win = windowListWithinRows(filtered.length, safeIndex, listRows)
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
      if (key.ctrl && input.toLowerCase() === "r") return onRefresh?.()
      if (key.ctrl && input.toLowerCase() === "a") return onApply?.()
      if (key.ctrl && (input === "n" || input === "N")) return onAdd()
      if (key.ctrl && (input === "x" || input === "X")) {
        if (current && editable(current)) onRemove(rowId(current))
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
        if (current && editable(current)) onToggle(rowId(current))
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
      <Text bold wrap="truncate-end">
        {t("mcp.title", { count: servers.length })}
        {probing ? (
          <Text color={theme.info}>
            {"  "}
            <Spinner /> {t("mcp.probing")}
          </Text>
        ) : null}
      </Text>
      <Text wrap="truncate-end">
        <Text color={theme.muted}>{t("mcp.filter")}</Text>
        {query ? (
          <Text>{query}</Text>
        ) : (
          <Text color={theme.muted} dimColor>
            {t("mcp.all")}
          </Text>
        )}
      </Text>
      {filtered.length === 0 ? (
        <Text color={theme.muted} dimColor>
          {"  "}
          {t("mcp.noMatches")}
        </Text>
      ) : (
        <>
          {win.above > 0 ? (
            <Text color={theme.muted} dimColor>
              {t("moreAbove", { count: win.above })}
            </Text>
          ) : null}
          {visible.map((s, i) => {
            const row = win.start + i
            const selected = row === safeIndex
            const badge = statusBadge(s)
            const hint = hintFor(s)
            return (
              <Text
                key={rowId(s)}
                color={selected ? theme.accent : undefined}
                bold={selected}
                wrap="truncate-end"
              >
                {selected ? "❯ " : "  "}
                <Text color={theme[badge.token]}>{badge.glyph}</Text> {s.name}
                <Text color={theme.muted}>
                  {" "}
                  · {s.transport} · {t(`mcp.sourceStatus.${s.source ?? "cognia"}`)}
                  {s.sessionStatus
                    ? ` · ${t(s.sessionScope === "agent" ? "mcp.agentInventory" : "mcp.session", { status: t(`mcp.sessionStatus.${s.sessionStatus}`) })}`
                    : ""}
                  {editable(s)
                    ? ` · ${t("mcp.probe", { status: t(`mcp.probeStatus.${s.enabled ? s.status : "disabled"}`) })}`
                    : ""}
                  {s.sessionToolCount != null && editable(s)
                    ? ` · ${t("mcp.sessionTools", { count: s.sessionToolCount })}`
                    : ""}
                  {hint ? ` · ${hint}` : ""}
                </Text>
              </Text>
            )
          })}
          {win.below > 0 ? (
            <Text color={theme.muted} dimColor>
              {t("moreBelow", { count: win.below })}
            </Text>
          ) : null}
        </>
      )}
      {current && shownDetails.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text
            bold
            wrap="truncate-end"
            color={
              current.status === "needs_auth"
                ? theme.warning
                : current.status === "failed"
                  ? theme.danger
                  : theme.muted
            }
          >
            {t(
              current.status === "failed" || current.status === "needs_auth"
                ? "mcp.issue"
                : "mcp.detailsTitle",
              { name: current.name }
            )}
          </Text>
          {shownDetails.map((line, i) => (
            <Text key={`${current.name}-detail-${i}`} color={theme.muted} wrap="truncate-end">
              {i === 0 ? "  " : "  ↳ "}
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
      <Text color={theme.muted} wrap="wrap">
        {scopeText}
      </Text>
      <OverlayFooter hint={t("mcp.footer")} />
      {onApply || onRefresh ? <OverlayFooter hint={t("mcp.sessionFooter")} /> : null}
    </Box>
  )
}
