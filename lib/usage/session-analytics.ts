/**
 * Pure billing analytics over `sessionUsage` rows (per-turn token + cost
 * records persisted on every SDK `result` event by `lib/db/session-usage.ts`).
 *
 * The headline gap this closes: the SDK only reports `total_cost_usd` for the
 * subscription/Anthropic path, so non-SDK turns land with `costUsd: 0`. We
 * back-fill those from the static pricing tables in `types/system/usage.ts`
 * (`getModelPricingUSD`, which already folds in CNY-native rates), keeping the
 * SDK's own figure whenever it is present (it is the most accurate — it
 * already accounts for cache tiers).
 *
 * Everything here is side-effect-free and clock-injectable for deterministic
 * tests; the renderer lives in
 * `components/settings/subscription/tabs/usage-tab.tsx`.
 */

import type { SessionUsageRow } from "@/lib/db/session-usage"
import { getModelPricingUSD, type DailyUsage } from "@/types/system/usage"

/** Per-1M-token price resolver. Defaults to the project pricing tables. */
export type PriceLookup = (model: string) => { input: number; output: number } | null

/**
 * Anthropic prompt-caching multipliers relative to the base input rate:
 * a cache read is billed at 0.1×, a 5-minute cache write at 1.25×. Used only
 * when we have to estimate cost ourselves (SDK cost absent); the SDK figure
 * already bakes these in.
 */
export const CACHE_READ_MULT = 0.1
export const CACHE_WRITE_MULT = 1.25

const DAY_MS = 86_400_000

/**
 * Cost of one turn in USD. Prefers the SDK-reported `costUsd` when present
 * (`> 0`); otherwise estimates from the pricing tables, adding cache tokens at
 * the Anthropic multipliers. Returns 0 when the model has no known pricing.
 */
export function effectiveCostUsd(
  row: SessionUsageRow,
  priceFor: PriceLookup = getModelPricingUSD
): number {
  if (row.costUsd > 0) return row.costUsd
  const pricing = row.model ? priceFor(row.model) : null
  if (!pricing) return 0
  const inRate = pricing.input / 1_000_000
  const outRate = pricing.output / 1_000_000
  return (
    row.inputTokens * inRate +
    row.outputTokens * outRate +
    row.cacheReadTokens * inRate * CACHE_READ_MULT +
    row.cacheCreationTokens * inRate * CACHE_WRITE_MULT
  )
}

export interface ModelUsageRow {
  model: string
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  costUsd: number
}

/** Bucket rows by model, descending by cost (ties: total tokens, then name). */
export function aggregateByModel(
  rows: readonly SessionUsageRow[],
  priceFor: PriceLookup = getModelPricingUSD
): ModelUsageRow[] {
  const map = new Map<string, ModelUsageRow>()
  for (const r of rows) {
    const model = r.model ?? "(unknown)"
    const slot =
      map.get(model) ??
      ({
        model,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
      } satisfies ModelUsageRow)
    slot.turns += 1
    slot.inputTokens += r.inputTokens
    slot.outputTokens += r.outputTokens
    slot.cacheReadTokens += r.cacheReadTokens
    slot.costUsd += effectiveCostUsd(r, priceFor)
    map.set(model, slot)
  }
  return [...map.values()].sort(
    (a, b) =>
      b.costUsd - a.costUsd ||
      b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) ||
      a.model.localeCompare(b.model)
  )
}

/** Bucket rows by UTC day, ascending by date. Reuses the `DailyUsage` shape. */
export function aggregateByDay(
  rows: readonly SessionUsageRow[],
  priceFor: PriceLookup = getModelPricingUSD
): DailyUsage[] {
  const map = new Map<string, DailyUsage>()
  for (const r of rows) {
    const date = new Date(r.at).toISOString().slice(0, 10)
    const slot = map.get(date) ?? { date, tokens: 0, cost: 0, requests: 0 }
    slot.tokens += r.inputTokens + r.outputTokens + r.cacheReadTokens
    slot.cost += effectiveCostUsd(r, priceFor)
    slot.requests += 1
    map.set(date, slot)
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date))
}

export interface SessionUsageSummary {
  sessionId: string
  turns: number
  tokens: number
  costUsd: number
}

/**
 * Bucket rows by session, descending by cost. Mirrors the old `topByCost`
 * helper but uses {@link effectiveCostUsd} so sessions whose SDK cost was 0
 * still surface when their tokens carry a known price.
 */
export function aggregateBySession(
  rows: readonly SessionUsageRow[],
  priceFor: PriceLookup = getModelPricingUSD
): SessionUsageSummary[] {
  const map = new Map<string, SessionUsageSummary>()
  for (const r of rows) {
    const slot = map.get(r.sessionId) ?? {
      sessionId: r.sessionId,
      turns: 0,
      tokens: 0,
      costUsd: 0,
    }
    slot.turns += 1
    slot.tokens += r.inputTokens + r.outputTokens + r.cacheReadTokens
    slot.costUsd += effectiveCostUsd(r, priceFor)
    map.set(r.sessionId, slot)
  }
  return [...map.values()].sort(
    (a, b) => b.costUsd - a.costUsd || b.turns - a.turns || a.sessionId.localeCompare(b.sessionId)
  )
}

/** Keep rows whose `at` falls within the last `rangeDays`. `null` keeps all. */
export function filterByRange(
  rows: readonly SessionUsageRow[],
  rangeDays: number | null,
  now: number = Date.now()
): SessionUsageRow[] {
  if (rangeDays == null) return [...rows]
  const cutoff = now - rangeDays * DAY_MS
  return rows.filter((r) => r.at >= cutoff)
}

// ── Export ──────────────────────────────────────────────────────────────────
// Mirrors the column-escape pattern in `lib/connectors/audit-export.ts`.

const CSV_COLUMNS = [
  "messageId",
  "sessionId",
  "characterId",
  "at",
  "model",
  "inputTokens",
  "outputTokens",
  "cacheCreationTokens",
  "cacheReadTokens",
  "costUsd",
  "durationMs",
] as const

function csvEscape(value: unknown): string {
  if (value == null) return ""
  const s = String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Serialize raw usage rows to CSV (header row always present). */
export function toUsageCsv(rows: readonly SessionUsageRow[]): string {
  const header = CSV_COLUMNS.join(",")
  if (rows.length === 0) return header
  const body = rows
    .map((r) =>
      CSV_COLUMNS.map((col) => csvEscape((r as unknown as Record<string, unknown>)[col])).join(",")
    )
    .join("\n")
  return `${header}\n${body}`
}

/** Serialize raw usage rows to pretty JSON. */
export function toUsageJson(rows: readonly SessionUsageRow[]): string {
  return JSON.stringify(rows, null, 2)
}

/** `cognia-usage-2026-05-31.csv` style filename, date-stamped from `now`. */
export function buildUsageFilename(format: "csv" | "json", now: number = Date.now()): string {
  const stamp = new Date(now).toISOString().slice(0, 10)
  return `cognia-usage-${stamp}.${format}`
}

export { DAY_MS }
