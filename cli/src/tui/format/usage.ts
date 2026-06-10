/**
 * Pure formatters for the status footer + usage panel: token/cost humanizers and
 * context-window occupancy. Reuses the desktop's per-model context-window table
 * (`getModelContextWindow`) so the CLI and app agree.
 */
import { getModelContextWindow } from "@/lib/claude/usage"

import type { UsageInfo } from "../state/types"

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

/** Assemble the footer view-model from config + the latest usage. */
export function formatFooter(opts: {
  model?: string
  provider: string
  mode: string
  cwd: string
  usage?: UsageInfo
}): FooterModel {
  const totalTokens = (opts.usage?.inputTokens ?? 0) + (opts.usage?.outputTokens ?? 0)
  return {
    model: opts.model ?? "default",
    provider: opts.provider,
    mode: opts.mode,
    tokens: formatTokens(totalTokens),
    contextPct: contextPercent(opts.usage, opts.model),
    cost: formatCost(opts.usage?.totalCostUsd),
    cwd: shortenCwd(opts.cwd),
  }
}

export interface UsageRow {
  label: string
  value: string
}

/** Detailed rows for the expandable usage panel. */
export function usagePanelRows(
  usage: UsageInfo | undefined,
  modelId: string | undefined
): UsageRow[] {
  const u = usage ?? {}
  return [
    { label: "Input", value: formatTokens(u.inputTokens) },
    { label: "Output", value: formatTokens(u.outputTokens) },
    { label: "Cache read", value: formatTokens(u.cacheReadInputTokens) },
    { label: "Cache write", value: formatTokens(u.cacheCreationInputTokens) },
    {
      label: "Context",
      value: `${contextPercent(usage, modelId)}% of ${formatTokens(getModelContextWindow(modelId))}`,
    },
    { label: "Cost", value: formatCost(u.totalCostUsd) },
    { label: "Duration", value: u.durationMs ? `${(u.durationMs / 1000).toFixed(1)}s` : "—" },
  ]
}
