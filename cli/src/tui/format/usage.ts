/**
 * Pure formatters for the status footer + usage panel: token/cost humanizers and
 * context-window occupancy. Reuses the desktop's per-model context-window table
 * (`getModelContextWindow`) so the CLI and app agree.
 */
import { getModelContextWindow } from "@/lib/claude/usage"

import type { SessionTotals, UsageInfo } from "../state/types"

/** A zeroed session-totals accumulator. */
export function emptySessionTotals(): SessionTotals {
  return {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    durationMs: 0,
  }
}

/** Fold one turn's usage into the running session totals (pure). */
export function accumulateUsage(totals: SessionTotals, usage: UsageInfo): SessionTotals {
  return {
    costUsd: totals.costUsd + (usage.totalCostUsd ?? 0),
    inputTokens: totals.inputTokens + (usage.inputTokens ?? 0),
    outputTokens: totals.outputTokens + (usage.outputTokens ?? 0),
    cacheReadTokens: totals.cacheReadTokens + (usage.cacheReadInputTokens ?? 0),
    cacheCreationTokens: totals.cacheCreationTokens + (usage.cacheCreationInputTokens ?? 0),
    durationMs: totals.durationMs + (usage.durationMs ?? 0),
  }
}

/** Tokens currently occupying the context window (the prompt side of a turn). */
export function contextTokens(usage: UsageInfo | undefined): number {
  if (!usage) return 0
  return (
    (usage.inputTokens ?? 0) +
    (usage.cacheReadInputTokens ?? 0) +
    (usage.cacheCreationInputTokens ?? 0)
  )
}

/** Context occupancy as a 0–100 integer percentage. */
export function contextPercent(usage: UsageInfo | undefined, modelId: string | undefined): number {
  const window = getModelContextWindow(modelId)
  if (window <= 0) return 0
  const pct = Math.round((contextTokens(usage) / window) * 100)
  return Math.max(0, Math.min(100, pct))
}

/** Humanize a token count: 1234 → "1.2k", 1_200_000 → "1.2M". */
export function formatTokens(n: number | undefined): string {
  if (!n || n <= 0) return "0"
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** Humanize a USD cost. Sub-cent costs keep 4 decimals; otherwise 2–3. */
export function formatCost(usd: number | undefined): string {
  if (!usd || usd <= 0) return "$0.00"
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

export interface FooterModel {
  model: string
  provider: string
  mode: string
  tokens: string
  contextPct: number
  cost: string
  cwd: string
}

/** Shorten a long absolute path for the footer: keep the last two segments. */
export function shortenCwd(cwd: string, max = 40): string {
  if (cwd.length <= max) return cwd
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return "…" + cwd.slice(-(max - 1))
  return "…/" + parts.slice(-2).join("/")
}

/**
 * Assemble the footer view-model. `tokens` + `cost` reflect the cumulative
 * session totals (or fall back to the latest turn when no totals are given),
 * while `contextPct` always reflects the latest turn's prompt occupancy.
 */
export function formatFooter(opts: {
  model?: string
  provider: string
  mode: string
  cwd: string
  usage?: UsageInfo
  totals?: SessionTotals
}): FooterModel {
  const totalTokens = opts.totals
    ? opts.totals.inputTokens + opts.totals.outputTokens
    : (opts.usage?.inputTokens ?? 0) + (opts.usage?.outputTokens ?? 0)
  const cost = opts.totals ? opts.totals.costUsd : opts.usage?.totalCostUsd
  return {
    model: opts.model ?? "default",
    provider: opts.provider,
    mode: opts.mode,
    tokens: formatTokens(totalTokens),
    contextPct: contextPercent(opts.usage, opts.model),
    cost: formatCost(cost),
    cwd: shortenCwd(opts.cwd),
  }
}

export interface UsageRow {
  label: string
  value: string
}

/**
 * Detailed rows for the expandable usage panel. The Input/Output/Cache/Context
 * rows describe the latest turn; when `totals` is supplied the panel also shows
 * the cumulative session cost + token count.
 */
export function usagePanelRows(
  usage: UsageInfo | undefined,
  modelId: string | undefined,
  totals?: SessionTotals
): UsageRow[] {
  const u = usage ?? {}
  const rows: UsageRow[] = [
    { label: "Input", value: formatTokens(u.inputTokens) },
    { label: "Output", value: formatTokens(u.outputTokens) },
    { label: "Cache read", value: formatTokens(u.cacheReadInputTokens) },
    { label: "Cache write", value: formatTokens(u.cacheCreationInputTokens) },
    {
      label: "Context",
      value: `${contextPercent(usage, modelId)}% of ${formatTokens(getModelContextWindow(modelId))}`,
    },
  ]
  if (totals) {
    rows.push(
      { label: "Session tokens", value: formatTokens(totals.inputTokens + totals.outputTokens) },
      { label: "Session cost", value: formatCost(totals.costUsd) },
      {
        label: "Duration",
        value: totals.durationMs ? `${(totals.durationMs / 1000).toFixed(1)}s` : "—",
      }
    )
  } else {
    rows.push(
      { label: "Cost", value: formatCost(u.totalCostUsd) },
      { label: "Duration", value: u.durationMs ? `${(u.durationMs / 1000).toFixed(1)}s` : "—" }
    )
  }
  return rows
}
