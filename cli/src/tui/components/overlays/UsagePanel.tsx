/**
 * Expandable token/cost usage panel (`/usage`). Read-only — any key closes it.
 *
 * Beyond the per-turn / session rows it renders three visual sections, all from
 * pure helpers: a token-per-turn sparkline (`format/charts`), a prompt
 * composition bar (reused / new-cache / fresh / output), and a "top tools"
 * breakdown of the session's tool usage (`format/tool-stats`).
 */
import React from "react"
import { Box, Text, useInput } from "ink"

import { contextComposition, formatTokens, usagePanelRows } from "../../format/usage"
import { sparkline, stackedBar } from "../../format/charts"
import { progressBar } from "../../format/status-bar"
import { formatToolStatRow, topToolStats } from "../../format/tool-stats"
import type { SessionTotals, ToolStat, UsageInfo } from "../../state/types"

/** Composition segments, in render order, with their colors + legend labels. */
const COMPOSITION_LEGEND: { key: keyof ReturnType<typeof contextComposition>; color: string }[] = [
  { key: "cacheRead", color: "green" },
  { key: "cacheCreation", color: "yellow" },
  { key: "fresh", color: "blue" },
  { key: "output", color: "gray" },
]
const COMPOSITION_LABEL: Record<string, string> = {
  cacheRead: "reused",
  cacheCreation: "new",
  fresh: "fresh",
  output: "output",
}

function TokenTrend({ history }: { history: number[] }) {
  if (history.length < 2) return null
  const min = Math.min(...history)
  const max = Math.max(...history)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="gray">Token trend</Text>
      <Text>
        <Text color="cyan">{sparkline(history, 40)}</Text>
        <Text color="gray" dimColor>
          {"  "}
          {formatTokens(min)}–{formatTokens(max)}/turn
        </Text>
      </Text>
    </Box>
  )
}

function Composition({ usage }: { usage?: UsageInfo }) {
  const comp = contextComposition(usage)
  const total = comp.cacheRead + comp.cacheCreation + comp.fresh + comp.output
  if (total === 0) return null
  const runs = stackedBar(
    COMPOSITION_LEGEND.map((seg) => ({ value: comp[seg.key], color: seg.color })),
    30
  )
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="gray">Composition</Text>
      <Text>
        {runs.map((run, i) => (
          <Text key={i} color={run.color}>
            {run.text}
          </Text>
        ))}
      </Text>
      <Text dimColor>
        {COMPOSITION_LEGEND.filter((seg) => comp[seg.key] > 0).map((seg, i) => (
          <Text key={seg.key} color={seg.color}>
            {i > 0 ? "  " : ""}
            {COMPOSITION_LABEL[seg.key]} {formatTokens(comp[seg.key])}
          </Text>
        ))}
      </Text>
    </Box>
  )
}

function TopTools({ toolStats }: { toolStats: Record<string, ToolStat> }) {
  const rows = topToolStats(toolStats, 5)
  if (rows.length === 0) return null
  // Rows are sorted by call count desc, so the first is the busiest — scale the
  // relative bars against it.
  const maxCalls = rows[0].calls
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="gray">Top tools</Text>
      {rows.map((row) => (
        <Text key={row.name}>
          <Text color="cyan">{progressBar(row.calls, maxCalls, 8)}</Text>
          <Text color={row.errors > 0 ? "yellow" : undefined}> {formatToolStatRow(row)}</Text>
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
  usageHistory = [],
  toolStats = {},
  onClose,
}: {
  usage?: UsageInfo
  model?: string
  totals?: SessionTotals
  /** Per-model context window (from the catalog); falls back to the pattern table. */
  contextWindow?: number
  /** Per-turn token history for the trend sparkline (oldest → newest). */
  usageHistory?: number[]
  /** Per-tool call/error tallies for the "top tools" breakdown. */
  toolStats?: Record<string, ToolStat>
  onClose: () => void
}) {
  useInput((_input, key) => {
    if (key.escape || key.return) onClose()
  })
  const rows = usagePanelRows(usage, model, totals, contextWindow)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        Usage
      </Text>
      {rows.map((row) => (
        <Text key={row.label}>
          <Text color="gray">{row.label.padEnd(12)}</Text>
          {row.value}
        </Text>
      ))}
      <TokenTrend history={usageHistory} />
      <Composition usage={usage} />
      <TopTools toolStats={toolStats} />
      <Text color="gray" dimColor>
        esc to close
      </Text>
    </Box>
  )
}
