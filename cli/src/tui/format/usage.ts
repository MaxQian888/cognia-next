/**
 * Pure formatters for the status footer + usage panel: token/cost humanizers and
 * context-window occupancy. Reuses the desktop's per-model context-window table
 * (`getModelContextWindow`) so the CLI and app agree.
 */
import { getModelContextWindow, tokensInWindow } from "@/lib/claude/usage"
import { costFromTokensUsd } from "@/lib/usage/pricing"
import type { ModelPricing } from "@cognia/provider-types/provider"

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
/**
 * One turn's USD cost: the SDK-reported figure when present (paid API), else the
 * priced-from-tokens estimate (ai-sdk / subscription paths report `0`). Shared by
 * the session-total accumulator and the cost-trend sparkline so they never drift.
 */
export function turnCostUsd(usage: UsageInfo, pricing?: Partial<ModelPricing>): number {
  return usage.totalCostUsd && usage.totalCostUsd > 0
    ? usage.totalCostUsd
    : costFromUsage(usage, pricing)
}

export function accumulateUsage(
  totals: SessionTotals,
  usage: UsageInfo,
  pricing?: Partial<ModelPricing>
): SessionTotals {
  const turnCost = turnCostUsd(usage, pricing)
  return {
    costUsd: totals.costUsd + turnCost,
    inputTokens: totals.inputTokens + (usage.inputTokens ?? 0),
    outputTokens: totals.outputTokens + (usage.outputTokens ?? 0),
    cacheReadTokens: totals.cacheReadTokens + (usage.cacheReadInputTokens ?? 0),
    cacheCreationTokens: totals.cacheCreationTokens + (usage.cacheCreationInputTokens ?? 0),
    durationMs: totals.durationMs + (usage.durationMs ?? 0),
  }
}

/**
 * Fold one turn's usage into the per-model totals map, attributing it to the
 * model that ran the turn. Empty/blank `modelId` is bucketed under "default" so a
 * turn is never dropped. Pure — returns a new map.
 */
export function accumulateModelTotals(
  modelTotals: Record<string, SessionTotals>,
  modelId: string,
  usage: UsageInfo,
  pricing?: Partial<ModelPricing>
): Record<string, SessionTotals> {
  const key = modelId || "default"
  const prev = modelTotals[key] ?? emptySessionTotals()
  return { ...modelTotals, [key]: accumulateUsage(prev, usage, pricing) }
}

/** Tokens currently occupying the context window (the prompt side of a turn). */
export function contextTokens(usage: UsageInfo | undefined): number {
  return usage ? tokensInWindow(usage) : 0
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

/** Whether the provider explicitly reported prefix-cache usage for this turn. */
export function hasCacheTelemetry(usage: UsageInfo | undefined): boolean {
  return usage?.cacheReadInputTokens !== undefined || usage?.cacheCreationInputTokens !== undefined
}

/** Prompt-side cache efficiency, shared by turn and session presentations. */
export interface CacheSummary {
  promptTokens: number
  reusedTokens: number
  createdTokens: number
  freshTokens: number
  hitRate: number
  writeRate: number
  freshRate: number
}

function buildCacheSummary(fresh: number, reused: number, created: number): CacheSummary {
  const freshTokens = Math.max(0, fresh)
  const reusedTokens = Math.max(0, reused)
  const createdTokens = Math.max(0, created)
  const promptTokens = freshTokens + reusedTokens + createdTokens
  const ratio = (tokens: number) => (promptTokens > 0 ? tokens / promptTokens : 0)
  return {
    promptTokens,
    reusedTokens,
    createdTokens,
    freshTokens,
    hitRate: ratio(reusedTokens),
    writeRate: ratio(createdTokens),
    freshRate: ratio(freshTokens),
  }
}

/** Summarize one turn's prompt cache composition. */
export function cacheSummary(usage: UsageInfo | undefined): CacheSummary {
  return buildCacheSummary(
    usage?.contextInputTokens ?? usage?.inputTokens ?? 0,
    usage?.cacheReadInputTokens ?? 0,
    usage?.cacheCreationInputTokens ?? 0
  )
}

/** Summarize the cumulative prompt cache composition for a session. */
export function sessionCacheSummary(totals: SessionTotals): CacheSummary {
  return buildCacheSummary(totals.inputTokens, totals.cacheReadTokens, totals.cacheCreationTokens)
}

/**
 * Fraction (0–1) of the prompt served from the prefix cache — the prefix-cache
 * hit rate the harness-design notes call out as the key cost lever. 0 when the
 * prompt side is empty.
 */
export function cacheHitRatio(usage: UsageInfo | undefined): number {
  return cacheSummary(usage).hitRate
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
    fresh: usage?.contextInputTokens ?? usage?.inputTokens ?? 0,
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

/**
 * Compact elapsed-time label for the live "working" indicator (Codex-style):
 * `< 1m → "47s"`, `< 1h → "4m 07s"`, `≥ 1h → "1h 02m 09s"`. Sub-minute shows bare
 * seconds; minutes/hours zero-pad the trailing fields so the width stays steady
 * as the timer ticks. Negative / NaN inputs clamp to "0s".
 */
export function formatElapsed(ms: number | undefined): string {
  const totalSec = Math.max(0, Math.floor((ms ?? 0) / 1000))
  if (!Number.isFinite(totalSec)) return "0s"
  if (totalSec < 60) return `${totalSec}s`
  const s = totalSec % 60
  const totalMin = Math.floor(totalSec / 60)
  if (totalMin < 60) return `${totalMin}m ${String(s).padStart(2, "0")}s`
  const m = totalMin % 60
  const h = Math.floor(totalMin / 60)
  return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`
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
  const cacheReported = hasCacheTelemetry(usage)
  const rows: UsageRow[] = [
    { label: "Model", value: modelId || "default" },
    { label: "Input", value: formatTokens(u.inputTokens) },
    { label: "Output", value: formatTokens(u.outputTokens) },
    // Reasoning tokens are a subset of output (already billed at the output
    // rate) — shown only when the provider broke them out, for observability.
    ...(u.reasoningTokens && u.reasoningTokens > 0
      ? [{ label: "Reasoning", value: formatTokens(u.reasoningTokens) }]
      : []),
    {
      label: "Total",
      value: formatTokens((u.inputTokens ?? 0) + (u.outputTokens ?? 0)),
    },
    {
      label: "Cache read",
      value: cacheReported ? formatTokens(u.cacheReadInputTokens) : "not reported",
    },
    {
      label: "Cache write",
      value: cacheReported ? formatTokens(u.cacheCreationInputTokens) : "not reported",
    },
    {
      label: "Cache hit",
      value: cacheReported ? `${Math.round(cacheHitRatio(usage) * 100)}%` : "not reported",
    },
    {
      label: "Context",
      value: `${contextPercent(usage, modelId, window)}% of ${formatTokens(window)}`,
    },
  ]
  if (totals) {
    const sessionCache = sessionCacheSummary(totals)
    const sessionCacheReported =
      cacheReported || totals.cacheReadTokens > 0 || totals.cacheCreationTokens > 0
    rows.push(
      { label: "Session input", value: formatTokens(totals.inputTokens) },
      { label: "Session output", value: formatTokens(totals.outputTokens) },
      {
        label: "Session cache r",
        value: sessionCacheReported ? formatTokens(totals.cacheReadTokens) : "not reported",
      },
      {
        label: "Session cache w",
        value: sessionCacheReported ? formatTokens(totals.cacheCreationTokens) : "not reported",
      },
      ...(sessionCacheReported
        ? [
            { label: "Session prompt", value: formatTokens(sessionCache.promptTokens) },
            {
              label: "Session cache hit",
              value: `${Math.round(sessionCache.hitRate * 100)}%`,
            },
          ]
        : []),
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

/** One model's cumulative usage, humanized for the "Usage by model" table. */
export interface ModelUsageRow {
  /** Model id (the bucket key; "default" when the turn carried no model). */
  model: string
  input: string
  output: string
  cacheRead: string
  cacheWrite: string
  cacheHit: string
  cost: string
  /** Raw cost for sorting/sharing — heaviest model first. */
  costUsd: number
  /** Raw total tokens (in+out) for sorting when costs tie (all-unpriced). */
  totalTokens: number
}

/**
 * Build the per-model usage rows for the panel's "Usage by model" section,
 * mirroring Claude Code's `/usage` breakdown (input / output / cache read /
 * cache write + cost per model). Rows are sorted heaviest-first: by cost, then
 * by total tokens (so an all-unpriced session still ranks sensibly), then by
 * model id for a stable order. Models that contributed no tokens are dropped.
 */
export function modelUsageRows(modelTotals: Record<string, SessionTotals>): ModelUsageRow[] {
  return Object.entries(modelTotals)
    .map(([model, t]) => {
      const cache = sessionCacheSummary(t)
      return {
        model,
        input: formatTokens(t.inputTokens),
        output: formatTokens(t.outputTokens),
        cacheRead: formatTokens(t.cacheReadTokens),
        cacheWrite: formatTokens(t.cacheCreationTokens),
        cacheHit:
          t.cacheReadTokens > 0 || t.cacheCreationTokens > 0
            ? `${Math.round(cache.hitRate * 100)}%`
            : "—",
        cost: formatCost(t.costUsd),
        costUsd: t.costUsd,
        totalTokens: t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheCreationTokens,
      }
    })
    .filter((r) => r.totalTokens > 0)
    .sort(
      (a, b) =>
        b.costUsd - a.costUsd || b.totalTokens - a.totalTokens || a.model.localeCompare(b.model)
    )
}
