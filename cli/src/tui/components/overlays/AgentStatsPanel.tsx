/**
 * `/agent-stats` overview panel: aggregate statistics over other coding agents'
 * conversation histories (Claude Code / Codex / OpenCode), plus a selectable
 * conversation list. A compact stats header (KPIs · by-source · by-model bar ·
 * convs/day + tokens/day sparklines · top tools) sits above a windowed list;
 * ↑/↓ move, Enter drills into one conversation's health report, Esc closes.
 *
 * Read-only. Composes the pure chart/format helpers (`format/charts`,
 * `format/status-bar`, `format/usage`) exactly like {@link UsagePanel}, and the
 * windowed-list pattern of {@link AgentsPanel}.
 */
import React, { useState } from "react"
import { Box, Text } from "ink"
import { useModalInput } from "../../input/input-router"

import { useTheme } from "../../theme/context"
import { windowList } from "../list-window"
import { panelColumns } from "../overlay-layout"
import { OverlayFooter } from "../OverlayFooter"
import { sparkline, stackedBar } from "../../format/charts"
import { progressBar } from "../../format/status-bar"
import { formatCost, formatTokens } from "../../format/usage"
import {
  convRowMetrics,
  convRowTitle,
  type AgentStatsOverview,
  type ConvStatRow,
} from "../../runtime/agent-stats-model"

const FOOTER = "↑/↓ move · enter analyze · esc close"
const HEADER_RESERVE = 12
const MODEL_COLORS = ["accent", "success", "info", "warning"] as const

/** Short display id for a (possibly long / namespaced) model id. */
function shortModel(id: string): string {
  const base = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id
  return base.length > 18 ? base.slice(0, 17) + "…" : base
}

/** Source badge glyph — one letter, themed. */
function sourceTag(source: string): string {
  if (source.startsWith("claude")) return "CC"
  if (source.startsWith("codex")) return "CX"
  if (source.startsWith("opencode")) return "OC"
  return source.slice(0, 2).toUpperCase()
}

export interface AgentStatsPanelProps {
  overview: AgentStatsOverview
  rows: ConvStatRow[]
  onView: (row: ConvStatRow) => void
  onCancel: () => void
  isActive?: boolean
  maxRows?: number
  width?: number | string
}

export function AgentStatsPanel({
  overview,
  rows,
  onView,
  onCancel,
  isActive = true,
  maxRows = 20,
  width,
}: AgentStatsPanelProps): React.ReactElement {
  const theme = useTheme()
  const [index, setIndex] = useState(0)

  const safeIndex = rows.length > 0 ? Math.min(index, rows.length - 1) : 0
  const current = rows[safeIndex]
  const listMax = Math.max(3, maxRows - HEADER_RESERVE - overview.notes.length)
  // Rows cut their title to the columns they actually have; a row that wraps
  // costs a second terminal row the window budget never counted.
  const rowColumns = panelColumns(width)
  const win = windowList(rows.length, safeIndex, listMax)
  const visible = rows.slice(win.start, win.end)

  useModalInput(
    (_input, key) => {
      if (key.escape) return onCancel()
      if (key.upArrow) {
        setIndex(() => Math.max(0, safeIndex - 1))
        return
      }
      if (key.downArrow) {
        setIndex(() => Math.min(rows.length - 1, safeIndex + 1))
        return
      }
      if (key.return && current) onView(current)
    },
    { isActive }
  )

  const models = overview.byModel.slice(0, MODEL_COLORS.length)
  const modelBar = stackedBar(
    models.map((m, i) => ({
      value: m.inputTokens + m.outputTokens + m.cacheReadTokens,
      color: theme[MODEL_COLORS[i]],
    })),
    24
  )
  const convSeries = overview.convsPerDay.map((d) => d.count)
  const tokenSeries = overview.tokensPerDay.map((d) => d.tokens)
  const topTools = overview.topTools.slice(0, 5)
  const maxToolCalls = topTools[0]?.count ?? 0

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
      width={width}
    >
      <Text bold color={theme.accent}>
        Agent Stats
      </Text>

      {/* KPI line */}
      <Text>
        <Text bold>{overview.conversations}</Text>
        <Text color={theme.muted}> convs · </Text>
        <Text bold>{formatTokens(overview.messages)}</Text>
        <Text color={theme.muted}> msgs · </Text>
        <Text bold>{formatTokens(overview.tokens)}</Text>
        <Text color={theme.muted}> tok · </Text>
        <Text color={theme.success}>{formatCost(overview.costUsd)}</Text>
      </Text>

      {/* By source */}
      {overview.bySource.length > 0 ? (
        <Text>
          <Text color={theme.muted}>{"By source  "}</Text>
          {overview.bySource.map((s, i) => (
            <Text key={s.source}>
              {i > 0 ? <Text color={theme.muted}> · </Text> : null}
              {s.source} <Text color={theme.muted}>{s.conversations}</Text>
            </Text>
          ))}
        </Text>
      ) : null}

      {/* By model */}
      {models.length > 0 ? (
        <Text>
          <Text color={theme.muted}>{"By model   "}</Text>
          {modelBar.map((run, i) => (
            <Text key={i} color={run.color}>
              {run.text}
            </Text>
          ))}
          {"  "}
          {models.map((m, i) => (
            <Text key={m.model} color={theme[MODEL_COLORS[i]]}>
              {i > 0 ? " " : ""}
              {shortModel(m.model)}
            </Text>
          ))}
        </Text>
      ) : null}

      {/* Daily trends */}
      {convSeries.length >= 2 || tokenSeries.length >= 2 ? (
        <Text>
          <Text color={theme.muted}>{"Trends     "}</Text>
          <Text color={theme.accent}>{sparkline(convSeries, 20)}</Text>
          <Text color={theme.muted}> convs/day </Text>
          <Text color={theme.success}>{sparkline(tokenSeries, 20)}</Text>
          <Text color={theme.muted}> tok/day</Text>
        </Text>
      ) : null}

      {/* Top tools */}
      {topTools.length > 0 ? (
        <Text>
          <Text color={theme.muted}>{"Top tools  "}</Text>
          {topTools.map((t, i) => (
            <Text key={t.name}>
              {i > 0 ? "  " : ""}
              <Text color={theme.accent}>{progressBar(t.count, maxToolCalls, 5)}</Text> {t.name}{" "}
              <Text color={theme.muted}>{formatTokens(t.count)}</Text>
            </Text>
          ))}
        </Text>
      ) : null}

      {overview.notes.map((note) => (
        <Text key={note} color={theme.warning} dimColor>
          {"  "}
          {note}
        </Text>
      ))}

      {/* Conversation list */}
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.muted}>Conversations</Text>
        {rows.length === 0 ? (
          <Text color={theme.muted} dimColor>
            {"  "}none
          </Text>
        ) : (
          <>
            {win.above > 0 ? (
              <Text color={theme.muted} dimColor>{`  ↑ ${win.above} more`}</Text>
            ) : null}
            {visible.map((row, i) => {
              const rowIdx = win.start + i
              const selected = rowIdx === safeIndex
              return (
                <Text key={row.id} color={selected ? theme.accent : undefined} bold={selected}>
                  {selected ? "❯ " : "  "}
                  <Text color={theme.muted}>{sourceTag(row.source)} </Text>
                  {convRowTitle(row, rowColumns)}
                  <Text color={theme.muted}>{convRowMetrics(row)}</Text>
                </Text>
              )
            })}
            {win.below > 0 ? (
              <Text color={theme.muted} dimColor>{`  ↓ ${win.below} more`}</Text>
            ) : null}
          </>
        )}
      </Box>

      <OverlayFooter hint={FOOTER} />
    </Box>
  )
}
