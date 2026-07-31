/**
 * Usage-status snapshot + formatters — the supply side of the token-usage
 * presence feature (ADR: usage presence). Pure functions over `sessionUsage`
 * rows; the refresh runner (`lib/connectors/presence/usage-status-runner.ts`)
 * reads Dexie and feeds rows in.
 *
 * Two output tiers:
 *   - `formatShortStatus` — a badge-budget string ("AI 1.2M $3.4") for
 *     platform status APIs. Weighted truncation (CJK = 2) matches the Lark
 *     系统状态 title rule (20 units / 10 汉字); Slack's 100-char budget never
 *     binds in practice.
 *   - `buildUsageCardMarkdown` — a markdown block for the pinned-card tier.
 */

import type { SessionUsageRow } from "@/lib/db/session-usage"
import {
  aggregateByModel,
  effectiveCostUsd,
  filterByRange,
  type PricingResolver,
} from "@/lib/usage/session-analytics"
import { resolveModelPricingUsd } from "@/lib/usage/pricing"
import type { UsagePresenceWindow } from "@/types/connectors/presence"

export interface UsageStatusSnapshot {
  window: UsagePresenceWindow
  /** Window start (ms epoch) the rows were filtered from. */
  since: number
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** input + output + cacheRead — the "tokens" headline used everywhere else. */
  totalTokens: number
  /** Effective cost (SDK figure when present, else priced from tokens). */
  costUsd: number
  /** Top models by cost, descending (for the card tier). */
  topModels: Array<{ model: string; tokens: number; costUsd: number }>
}

/** Window start for a presence window. `today` = local midnight. */
export function windowStart(window: UsagePresenceWindow, now: number = Date.now()): number {
  if (window === "today") {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  return now - (window === "7d" ? 7 : 30) * 86_400_000
}

/** Build a snapshot from raw usage rows. Pure; clock-injectable. */
export function buildUsageStatusSnapshot(
  rows: readonly SessionUsageRow[],
  opts: {
    window?: UsagePresenceWindow
    now?: number
    resolve?: PricingResolver
    /** How many models the card tier lists. Default 3. */
    topModelCount?: number
  } = {}
): UsageStatusSnapshot {
  const window = opts.window ?? "today"
  const now = opts.now ?? Date.now()
  const resolve = opts.resolve ?? resolveModelPricingUsd
  const since = windowStart(window, now)
  const inRange = filterByRange(rows, null, now).filter((r) => r.at >= since)

  const snap: UsageStatusSnapshot = {
    window,
    since,
    turns: inRange.length,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    topModels: [],
  }
  for (const r of inRange) {
    snap.inputTokens += r.inputTokens
    snap.outputTokens += r.outputTokens
    snap.cacheReadTokens += r.cacheReadTokens
    snap.cacheCreationTokens += r.cacheCreationTokens
    snap.costUsd += effectiveCostUsd(r, resolve)
  }
  snap.totalTokens = snap.inputTokens + snap.outputTokens + snap.cacheReadTokens
  snap.topModels = aggregateByModel(inRange, resolve)
    .slice(0, Math.max(0, opts.topModelCount ?? 3))
    .map((m) => ({
      model: m.model,
      tokens: m.inputTokens + m.outputTokens + m.cacheReadTokens,
      costUsd: m.costUsd,
    }))
  return snap
}

/** 1234 → "1.2k", 1_234_567 → "1.2M". Whole numbers below 1000 unchanged. */
export function formatCompactTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0"
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return trimZero(n / 1000) + "k"
  if (n < 1_000_000_000) return trimZero(n / 1_000_000) + "M"
  return trimZero(n / 1_000_000_000) + "B"
}

function trimZero(v: number): string {
  const s = v.toFixed(1)
  return s.endsWith(".0") ? s.slice(0, -2) : s
}

/** Compact USD: `$0.42`, `$3.4`, `$120`. */
export function formatCompactUsd(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "$0"
  if (v < 1) return `$${v.toFixed(2)}`
  if (v < 100) return `$${trimZero(v)}`
  return `$${Math.round(v)}`
}

/**
 * Weighted string length matching Lark's 系统状态 title budget: a CJK
 * codepoint counts as 2 units, everything else as 1.
 */
export function weightedLength(s: string): number {
  let n = 0
  for (const ch of s) n += /[　-鿿豈-﫿！-｠]/.test(ch) ? 2 : 1
  return n
}

/** Truncate `s` to `maxUnits` weighted units (no ellipsis — badge budgets are tiny). */
export function truncateWeighted(s: string, maxUnits: number): string {
  let n = 0
  let out = ""
  for (const ch of s) {
    n += /[　-鿿豈-﫿！-｠]/.test(ch) ? 2 : 1
    if (n > maxUnits) return out
    out += ch
  }
  return out
}

/**
 * Badge-tier status text, e.g. `AI 1.2M $3.4`. Fits any budget ≥ 8 units by
 * degrading: full → drop cost → tokens only.
 */
export function formatShortStatus(
  snap: UsageStatusSnapshot,
  opts: { maxUnits?: number; prefix?: string } = {}
): string {
  const maxUnits = opts.maxUnits ?? 20
  const prefix = opts.prefix ?? "AI"
  const tokens = formatCompactTokens(snap.totalTokens)
  const cost = formatCompactUsd(snap.costUsd)
  const candidates = [`${prefix} ${tokens} ${cost}`, `${prefix} ${tokens}`, tokens]
  for (const c of candidates) {
    if (weightedLength(c) <= maxUnits) return c
  }
  return truncateWeighted(candidates[candidates.length - 1], maxUnits)
}

const WINDOW_LABEL: Record<UsagePresenceWindow, string> = {
  today: "Today / 今日",
  "7d": "Last 7 days / 近 7 天",
  "30d": "Last 30 days / 近 30 天",
}

/**
 * Card-tier markdown for the pinned usage card. Bilingual static labels
 * (IM-facing copy, not app UI — next-intl does not apply here; same
 * convention as the connector welcome card).
 */
export function buildUsageCardMarkdown(
  snap: UsageStatusSnapshot,
  opts: { now?: number } = {}
): string {
  const now = opts.now ?? Date.now()
  const lines = [
    `**Token Usage / 用量统计** — ${WINDOW_LABEL[snap.window]}`,
    "",
    `- Tokens: **${formatCompactTokens(snap.totalTokens)}** (in ${formatCompactTokens(snap.inputTokens)} / out ${formatCompactTokens(snap.outputTokens)} / cache ${formatCompactTokens(snap.cacheReadTokens)})`,
    `- Cost / 成本: **${formatCompactUsd(snap.costUsd)}**`,
    `- Turns / 轮次: ${snap.turns}`,
  ]
  if (snap.topModels.length > 0) {
    lines.push(
      `- Models: ${snap.topModels
        .map((m) => `${m.model} ${formatCompactTokens(m.tokens)} (${formatCompactUsd(m.costUsd)})`)
        .join(" · ")}`
    )
  }
  lines.push("", `_Updated ${new Date(now).toISOString().replace("T", " ").slice(0, 16)} UTC_`)
  return lines.join("\n")
}
