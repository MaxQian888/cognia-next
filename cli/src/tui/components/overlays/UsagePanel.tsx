/**
 * Expandable token/cost usage panel (`/usage`). Read-only — any key closes it.
 *
 * Beyond the per-turn / session rows it renders three visual sections, all from
 * pure helpers: a token-per-turn sparkline (`format/charts`), a prompt
 * composition bar (reused / new-cache / fresh / output), and a "top tools"
 * breakdown of the session's tool usage (`format/tool-stats`).
 */
import React from "react"
import { Box, Text, useInput, useStdout } from "ink"

import {
  PANEL_CHROME_ROWS,
  PanelViewport,
  panelFooterHint,
  usePanelScroll,
} from "../../hooks/usePanelScroll"
import {
  contextComposition,
  formatCost,
  formatTokens,
  modelUsageRows,
  usagePanelRows,
} from "../../format/usage"
import { sparkline, stackedBar } from "../../format/charts"
import { progressBar } from "../../format/status-bar"
import { formatToolStatRow, topToolStats } from "../../format/tool-stats"
import { useTheme } from "../../theme/context"
import type { ThemePalette } from "../../theme/palette"
import type { ModelPricing } from "@cognia/provider-types/provider"
import type { SessionTotals, ToolStat, UsageInfo } from "../../state/types"

/** Composition segments, in render order, with their palette token + legend labels. */
const COMPOSITION_LEGEND: {
  key: keyof ReturnType<typeof contextComposition>
  color: keyof ThemePalette
}[] = [
  { key: "cacheRead", color: "success" },
  { key: "cacheCreation", color: "warning" },
  { key: "fresh", color: "info" },
  { key: "output", color: "muted" },
]
const COMPOSITION_LABEL: Record<string, string> = {
  cacheRead: "reused",
  cacheCreation: "new",
  fresh: "fresh",
  output: "output",
}

function TokenTrend({ history }: { history: number[] }) {
  const theme = useTheme()
  if (history.length < 2) return null
  const min = Math.min(...history)
  const max = Math.max(...history)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.muted}>Token trend</Text>
      <Text>
        <Text color={theme.accent}>{sparkline(history, 40)}</Text>
        <Text color={theme.muted} dimColor>
          {"  "}
          {formatTokens(min)}–{formatTokens(max)}/turn
        </Text>
      </Text>
    </Box>
  )
}

function CostTrend({ history }: { history: number[] }) {
  const theme = useTheme()
  // Need ≥2 points, and at least one priced turn — an all-zero series (free /
  // unpriced model) would just render a flat baseline with "$0.00" bounds.
  if (history.length < 2 || history.every((c) => c <= 0)) return null
  const min = Math.min(...history)
  const max = Math.max(...history)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.muted}>Cost trend</Text>
      <Text>
        <Text color={theme.success}>{sparkline(history, 40)}</Text>
        <Text color={theme.muted} dimColor>
          {"  "}
          {formatCost(min)}–{formatCost(max)}/turn
        </Text>
      </Text>
    </Box>
  )
}

function Composition({ usage }: { usage?: UsageInfo }) {
  const theme = useTheme()
  const comp = contextComposition(usage)
  const total = comp.cacheRead + comp.cacheCreation + comp.fresh + comp.output
  if (total === 0) return null
  const runs = stackedBar(
    COMPOSITION_LEGEND.map((seg) => ({ value: comp[seg.key], color: theme[seg.color] })),
    30
  )
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.muted}>Composition</Text>
      <Text>
        {runs.map((run, i) => (
          <Text key={i} color={run.color}>
            {run.text}
          </Text>
        ))}
      </Text>
      <Text dimColor>
        {COMPOSITION_LEGEND.filter((seg) => comp[seg.key] > 0).map((seg, i) => (
          <Text key={seg.key} color={theme[seg.color]}>
            {i > 0 ? "  " : ""}
            {COMPOSITION_LABEL[seg.key]} {formatTokens(comp[seg.key])}
          </Text>
        ))}
      </Text>
    </Box>
  )
}

/**
 * Per-model cumulative breakdown — Claude Code's `/usage` "Usage by model"
 * section. One model per block: the id, then a dim detail line of input /
 * output / cache-read / cache-write tokens and its cost. Heaviest model first.
 */
function UsageByModel({ modelTotals }: { modelTotals: Record<string, SessionTotals> }) {
  const theme = useTheme()
  const rows = modelUsageRows(modelTotals)
  // A single model adds no information the Session rows don't already carry —
  // the breakdown earns its space only once two+ models have run.
  if (rows.length < 2) return null
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.muted}>Usage by model</Text>
      {rows.map((row) => (
        <Box key={row.model} flexDirection="column">
          <Text color={theme.accent}>{row.model}</Text>
          <Text dimColor>
            {"  "}
            {row.input} in · {row.output} out · {row.cacheRead} cache r · {row.cacheWrite} cache w ·{" "}
            <Text color={theme.success}>{row.cost}</Text>
          </Text>
        </Box>
      ))}
    </Box>
  )
}

function TopTools({ toolStats }: { toolStats: Record<string, ToolStat> }) {
  const theme = useTheme()
  const rows = topToolStats(toolStats, 5)
  if (rows.length === 0) return null
  // Rows are sorted by call count desc, so the first is the busiest — scale the
  // relative bars against it.
  const maxCalls = rows[0].calls
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.muted}>Top tools</Text>
      {rows.map((row) => (
        <Text key={row.name}>
          <Text color={theme.accent}>{progressBar(row.calls, maxCalls, 8)}</Text>
          <Text color={row.errors > 0 ? theme.warning : undefined}> {formatToolStatRow(row)}</Text>
        </Text>
      ))}
    </Box>
  )
}

export function UsagePanel({
  usage,
  model,
  totals,
  contextWindow,
  pricing,
  usageHistory = [],
  costHistory = [],
  toolStats = {},
  modelTotals = {},
  viewportRows,
  onClose,
}: {
  usage?: UsageInfo
  model?: string
  totals?: SessionTotals
  /** Per-model context window (from the catalog); falls back to the pattern table. */
  contextWindow?: number
  /** Resolved per-model pricing — lets the cost row show "—" (unknown) vs "$0.00" (free). */
  pricing?: Partial<ModelPricing>
  /** Per-turn token history for the trend sparkline (oldest → newest). */
  usageHistory?: number[]
  /** Per-turn USD cost history for the cost-trend sparkline (oldest → newest). */
  costHistory?: number[]
  /** Per-tool call/error tallies for the "top tools" breakdown. */
  toolStats?: Record<string, ToolStat>
  /** Per-model cumulative totals for the "Usage by model" breakdown. */
  modelTotals?: Record<string, SessionTotals>
  /** Test seam: viewport height in rows (defaults to the terminal height). */
  viewportRows?: number
  onClose: () => void
}) {
  const theme = useTheme()
  const { stdout } = useStdout()
  const viewport =
    viewportRows ?? Math.max(4, ((stdout?.rows as number | undefined) ?? 24) - PANEL_CHROME_ROWS)
  const scroll = usePanelScroll(viewport)
  useInput((input, key) => {
    if (key.escape || key.return) return onClose()
    scroll.onKey(input, key)
  })
  const rows = usagePanelRows(usage, model, totals, contextWindow, pricing)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text bold color={theme.accent}>
        Usage
      </Text>
      <PanelViewport viewportRows={viewport} scroll={scroll}>
        {rows.map((row) => (
          <Text key={row.label}>
            <Text color={theme.muted}>{row.label.padEnd(12)}</Text>
            {row.value}
          </Text>
        ))}
        <UsageByModel modelTotals={modelTotals} />
        <TokenTrend history={usageHistory} />
        <CostTrend history={costHistory} />
        <Composition usage={usage} />
        <TopTools toolStats={toolStats} />
      </PanelViewport>
      <Text color={theme.muted} dimColor>
        {panelFooterHint(scroll.hidden)}
      </Text>
    </Box>
  )
}
