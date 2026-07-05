/**
 * `/agent-stats` drill-down: one imported conversation's health report, the CLI
 * rendering of the shared {@link SessionReport} (`lib/analysis/session-report`).
 * KPIs · token breakdown · per-model · top tools · behavioural signals · the 7
 * scored health assessments. Read-only + scrollable (like {@link UsagePanel});
 * any of Esc/Enter returns to the overview.
 */
import React from "react"
import { Box, Text, useInput, useStdout } from "ink"

import {
  PANEL_CHROME_ROWS,
  PanelViewport,
  panelFooterHint,
  usePanelScroll,
} from "../../hooks/usePanelScroll"
import { progressBar } from "../../format/status-bar"
import { formatCost, formatElapsed, formatTokens } from "../../format/usage"
import { useTheme } from "../../theme/context"
import type { ThemePalette } from "../../theme/palette"
import type { Assessment, AssessmentLevel, SessionReport } from "@/lib/analysis/session-report"

const ASSESSMENT_LABEL: Record<Assessment["id"], string> = {
  cacheEfficiency: "Cache efficiency",
  toolHealth: "Tool health",
  thrashing: "Thrashing",
  redundancy: "Redundancy",
  costPerCommit: "Cost per commit",
  overhead: "Startup overhead",
  context: "Context pressure",
}

const LEVEL_STYLE: Record<AssessmentLevel, { glyph: string; color: keyof ThemePalette }> = {
  healthy: { glyph: "✓", color: "success" },
  info: { glyph: "•", color: "muted" },
  warning: { glyph: "⚠", color: "warning" },
  critical: { glyph: "✗", color: "danger" },
}

function num(params: Assessment["params"], key: string): number | string | undefined {
  return params?.[key]
}

/** A one-line detail phrase for an assessment, from its known params. */
function assessmentDetail(a: Assessment): string {
  const p = a.params
  switch (a.id) {
    case "cacheEfficiency":
      return num(p, "ratio") !== undefined ? `${num(p, "ratio")}× reuse` : "no cache writes"
    case "toolHealth":
      return `${num(p, "pct") ?? 0}% errors (${num(p, "errors") ?? 0})`
    case "thrashing":
      return `${num(p, "events") ?? 0} repeat events`
    case "redundancy":
      return `${num(p, "duplicates") ?? 0} duplicate calls`
    case "costPerCommit":
      return num(p, "commits")
        ? `$${num(p, "cost") ?? 0}/commit · ${num(p, "commits")} commits`
        : "no commits"
    case "overhead":
      return `${num(p, "turns") ?? 0} turns before first tool`
    case "context":
      return `${num(p, "pct") ?? 0}% peak context`
    default:
      return ""
  }
}

export interface AgentStatsDetailPanelProps {
  report: SessionReport
  title: string
  onClose: () => void
  viewportRows?: number
}

export function AgentStatsDetailPanel({
  report,
  title,
  onClose,
  viewportRows,
}: AgentStatsDetailPanelProps): React.ReactElement {
  const theme = useTheme()
  const { stdout } = useStdout()
  const viewport =
    viewportRows ?? Math.max(4, ((stdout?.rows as number | undefined) ?? 24) - PANEL_CHROME_ROWS)
  const scroll = usePanelScroll(viewport)
  useInput((input, key) => {
    if (key.escape || key.return) return onClose()
    scroll.onKey(input, key)
  })

  const topTools = Object.entries(report.toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
  const maxToolCalls = topTools[0]?.[1] ?? 0

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text bold color={theme.accent}>
        {title.replace(/\s+/g, " ").slice(0, 70) || "Conversation"}
      </Text>
      <PanelViewport viewportRows={viewport} scroll={scroll}>
        {/* KPIs */}
        <Text>
          <Text bold>{report.turns}</Text>
          <Text color={theme.muted}> turns · </Text>
          <Text color={theme.success}>{formatCost(report.totalCostUsd)}</Text>
          <Text color={theme.muted}> · </Text>
          {formatElapsed(report.durationSeconds * 1000)}
          {report.commitCount > 0 ? (
            <Text color={theme.muted}> · {report.commitCount} commits</Text>
          ) : null}
        </Text>

        {/* Token breakdown */}
        <Text>
          <Text color={theme.muted}>{"Tokens  "}</Text>
          in {formatTokens(report.totalInputTokens)} · out {formatTokens(report.totalOutputTokens)}{" "}
          · cache r {formatTokens(report.totalCacheReadTokens)} · w{" "}
          {formatTokens(report.totalCacheCreationTokens)}
        </Text>

        {/* Per-model */}
        {report.models.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.muted}>By model</Text>
            {report.models.map((m) => (
              <Text key={m.model}>
                {"  "}
                <Text color={theme.accent}>{m.model}</Text>
                <Text color={theme.muted}>
                  {" · "}
                  {formatTokens(m.inputTokens)} in · {formatTokens(m.outputTokens)} out ·{" "}
                </Text>
                <Text color={theme.success}>{formatCost(m.costUsd)}</Text>
              </Text>
            ))}
          </Box>
        ) : null}

        {/* Top tools */}
        {topTools.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.muted}>Top tools</Text>
            {topTools.map(([name, count]) => (
              <Text key={name}>
                {"  "}
                <Text color={theme.accent}>{progressBar(count, maxToolCalls, 8)}</Text> {name}{" "}
                <Text color={theme.muted}>{count}</Text>
              </Text>
            ))}
          </Box>
        ) : null}

        {/* Signals */}
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.muted}>Signals</Text>
          <Text>
            {"  "}thinking {report.thinkingCount} · errors {report.errorCount} · denials{" "}
            {report.denialCount} · friction {report.frictionTotal} · idle gaps{" "}
            {report.idleGaps.length} · model switches {report.modelSwitches.length}
          </Text>
        </Box>

        {/* Health assessments */}
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.muted}>Health</Text>
          {report.assessments.map((a) => {
            const style = LEVEL_STYLE[a.level]
            return (
              <Text key={a.id}>
                {"  "}
                <Text color={theme[style.color]}>{style.glyph}</Text> {ASSESSMENT_LABEL[a.id]}
                <Text color={theme.muted}> — {assessmentDetail(a)}</Text>
              </Text>
            )
          })}
        </Box>
      </PanelViewport>
      <Text color={theme.muted} dimColor>
        {panelFooterHint(scroll.hidden)}
      </Text>
    </Box>
  )
}
