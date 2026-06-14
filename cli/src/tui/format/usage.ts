/**
 * Pure formatters for the status footer + usage panel: token/cost humanizers and
 * context-window occupancy. Reuses the desktop's per-model context-window table
 * (`getModelContextWindow`) so the CLI and app agree.
 */
import { getModelContextWindow } from "@/lib/claude/usage"
import { costFromTokensUsd } from "@/lib/usage/pricing"
import type { ModelPricing } from "@/types/provider/provider"

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

/**
 * Price one turn's tokens from per-1M-token rates. Used as the cost fallback
 * when the SDK didn't report a `totalCostUsd` — the ai-sdk dispatch path always
 * emits `total_cost_usd: 0` for non-Anthropic providers, so without this the
 * footer's cost segment would stay "$0.00" while tokens climb. Delegates to the
 * shared {@link costFromTokensUsd} so the CLI and the desktop price an identical
 * turn identically: explicit cache rates win, otherwise cache reads/writes fall
 * back to the Anthropic input-rate multipliers (0.1× / 1.25×) — not the full
 * input rate, which used to over-charge cached reads ~10×. Returns 0 when no
 * usable rate is known.
 */
export function costFromUsage(usage: UsageInfo, pricing?: Partial<ModelPricing>): number {
  return costFromTokensUsd(
    {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
    },
    pricing ?? null
  )
}

/**
 * Fold one turn's usage into the running session totals (pure). When `usage`
 * carries no positive `totalCostUsd` (the common case for ai-sdk / subscription
 * providers) the cost is estimated from `pricing` so the footer keeps in sync.
 */
export function accumulateUsage(
  totals: SessionTotals,
  usage: UsageInfo,
  pricing?: Partial<ModelPricing>
): SessionTotals {
  const turnCost =
    usage.totalCostUsd && usage.totalCostUsd > 0
      ? usage.totalCostUsd
      : costFromUsage(usage, pricing)
  return {
    costUsd: totals.costUsd + turnCost,
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

/**
 * Context occupancy as a 0–100 integer percentage. `windowOverride` (the
 * per-model window resolved from the models.dev catalog) wins when positive;
 * otherwise the pattern-table window for `modelId` is used.
 */
export function contextPercent(
  usage: UsageInfo | undefined,
  modelId: string | undefined,
  windowOverride?: number
): number {
  const window =
    windowOverride && windowOverride > 0 ? windowOverride : getModelContextWindow(modelId)
  if (window <= 0) return 0
  const pct = Math.round((contextTokens(usage) / window) * 100)
  return Math.max(0, Math.min(100, pct))
}

/**
 * Fraction (0–1) of the prompt served from the prefix cache — the prefix-cache
 * hit rate the harness-design notes call out as the key cost lever. 0 when the
 * prompt side is empty.
 */
export function cacheHitRatio(usage: UsageInfo | undefined): number {
  if (!usage) return 0
  const promptTotal = contextTokens(usage)
  if (promptTotal <= 0) return 0
  return (usage.cacheReadInputTokens ?? 0) / promptTotal
}

/** Token breakdown of a turn for the composition bar (prompt side + output). */
export interface ContextComposition {
  /** Reused prefix-cache tokens. */
  cacheRead: number
  /** Newly written cache tokens. */
  cacheCreation: number
  /** Fresh (uncached) input tokens. */
  fresh: number
  /** Output (completion) tokens. */
  output: number
}

/** Decompose a turn's usage into reused / new-cache / fresh / output tokens. */
export function contextComposition(usage: UsageInfo | undefined): ContextComposition {
  return {
    cacheRead: usage?.cacheReadInputTokens ?? 0,
    cacheCreation: usage?.cacheCreationInputTokens ?? 0,
    fresh: usage?.inputTokens ?? 0,
    output: usage?.outputTokens ?? 0,
  }
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

/** Whether a pricing record carries a usable base (prompt or completion) rate. */
function hasBaseRate(pricing?: Partial<ModelPricing>): boolean {
  return (
    !!pricing &&
    (typeof pricing.promptPer1M === "number" || typeof pricing.completionPer1M === "number")
  )
}

/**
 * Format a cost while distinguishing a genuinely-free `$0` from "pricing
 * unknown": shows the dollar figure when the cost is positive or the model's
 * price is known, otherwise "—" so an unpriced model isn't read as free.
 */
export function formatCostKnown(usd: number | undefined, known: boolean): string {
  if ((usd ?? 0) > 0 || known) return formatCost(usd)
  return "—"
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
  /** Per-model context window (from the catalog); falls back to the pattern table. */
  contextWindow?: number
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
    contextPct: contextPercent(opts.usage, opts.model, opts.contextWindow),
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
  totals?: SessionTotals,
  windowOverride?: number,
  pricing?: Partial<ModelPricing>
): UsageRow[] {
  const u = usage ?? {}
  const window =
    windowOverride && windowOverride > 0 ? windowOverride : getModelContextWindow(modelId)
  const costKnown = hasBaseRate(pricing)
  const rows: UsageRow[] = [
    { label: "Input", value: formatTokens(u.inputTokens) },
    { label: "Output", value: formatTokens(u.outputTokens) },
    // Reasoning tokens are a subset of output (already billed at the output
    // rate) — shown only when the provider broke them out, for observability.
    ...(u.reasoningTokens && u.reasoningTokens > 0
      ? [{ label: "Reasoning", value: formatTokens(u.reasoningTokens) }]
      : []),
    { label: "Cache read", value: formatTokens(u.cacheReadInputTokens) },
    { label: "Cache write", value: formatTokens(u.cacheCreationInputTokens) },
    { label: "Cache hit", value: `${Math.round(cacheHitRatio(usage) * 100)}%` },
    {
      label: "Context",
      value: `${contextPercent(usage, modelId, window)}% of ${formatTokens(window)}`,
    },
  ]
  if (totals) {
    rows.push(
      { label: "Session tokens", value: formatTokens(totals.inputTokens + totals.outputTokens) },
      { label: "Session cost", value: formatCostKnown(totals.costUsd, costKnown) },
      {
        label: "Duration",
        value: totals.durationMs ? `${(totals.durationMs / 1000).toFixed(1)}s` : "—",
      }
    )
  } else {
    rows.push(
      { label: "Cost", value: formatCostKnown(u.totalCostUsd, costKnown) },
      { label: "Duration", value: u.durationMs ? `${(u.durationMs / 1000).toFixed(1)}s` : "—" }
    )
  }
  return rows
}
