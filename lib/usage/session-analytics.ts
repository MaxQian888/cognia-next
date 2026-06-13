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
import type { DailyUsage } from "@/types/system/usage"
import type { ModelPricing } from "@/types/provider/provider"
import {
  DEFAULT_CACHE_READ_MULT,
  DEFAULT_CACHE_WRITE_MULT,
  costFromTokensUsd,
  resolveModelPricingUsd,
} from "@/lib/usage/pricing"

/**
 * Full-pricing resolver seam. Defaults to the unified
 * {@link resolveModelPricingUsd} (catalog-first, static-table fallback) so the
 * analytics tab, the live composer read-out, and the CLI footer all price a
 * turn identically. Injectable for deterministic tests.
 */
export type PricingResolver = (
  providerId: string | undefined,
  modelId: string | undefined
) => Partial<ModelPricing> | null

/**
 * Anthropic prompt-caching multipliers relative to the base input rate:
 * a cache read is billed at 0.1×, a 5-minute cache write at 1.25×. Re-exported
 * from the unified pricing module — these are now the *fallback* used by
 * {@link costFromTokensUsd} only when the resolved pricing carries no explicit
 * cache rate; the SDK figure (when present) already bakes real rates in.
 */
export const CACHE_READ_MULT = DEFAULT_CACHE_READ_MULT
export const CACHE_WRITE_MULT = DEFAULT_CACHE_WRITE_MULT

const DAY_MS = 86_400_000

/**
 * Cost of one turn in USD. Prefers the SDK-reported `costUsd` when present
 * (`> 0`); otherwise resolves the model's full pricing and prices the token
 * breakdown — explicit cache rates when the catalog knows them, else the
 * Anthropic multipliers. Returns 0 when the model has no known pricing.
 */
export function effectiveCostUsd(
  row: SessionUsageRow,
  resolve: PricingResolver = resolveModelPricingUsd
): number {
  if (row.costUsd > 0) return row.costUsd
  const pricing = resolve(row.providerId, row.model)
  return costFromTokensUsd(
    {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadInputTokens: row.cacheReadTokens,
      cacheCreationInputTokens: row.cacheCreationTokens,
    },
    pricing
  )
}

/** Summed token counts for a session (camel-cased, as the live UI carries them). */
export interface SessionTokenTotals {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

/**
 * Estimate a session's cost in USD from its summed token counts when the SDK
 * never reported one (the ai-sdk / non-Anthropic path always emits
 * `total_cost_usd: 0`). Shares {@link effectiveCostUsd}'s pricing path — explicit
 * cache rates when the catalog knows them, else the Anthropic multipliers — but
 * operates on whole-session totals so the live composer read-out stops showing
 * "$0.00" for priced models. Returns 0 when the model has no known pricing.
 */
export function estimateCostFromTotals(
  totals: SessionTokenTotals,
  modelId: string | undefined,
  providerId?: string,
  resolve: PricingResolver = resolveModelPricingUsd
): number {
  const pricing = resolve(providerId, modelId)
  return costFromTokensUsd(totals, pricing)
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
  resolve: PricingResolver = resolveModelPricingUsd
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
    slot.costUsd += effectiveCostUsd(r, resolve)
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
  resolve: PricingResolver = resolveModelPricingUsd
): DailyUsage[] {
  const map = new Map<string, DailyUsage>()
  for (const r of rows) {
    const date = new Date(r.at).toISOString().slice(0, 10)
    const slot = map.get(date) ?? { date, tokens: 0, cost: 0, requests: 0 }
    slot.tokens += r.inputTokens + r.outputTokens + r.cacheReadTokens
    slot.cost += effectiveCostUsd(r, resolve)
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
  resolve: PricingResolver = resolveModelPricingUsd
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
    slot.costUsd += effectiveCostUsd(r, resolve)
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
  "surface",
  "at",
  "model",
  "inputTokens",
  "outputTokens",
  "cacheCreationTokens",
  "cacheReadTokens",
  "costUsd",
  // Cost actually charged: the SDK figure when present, else priced from the
  // model's tokens. Without this column non-Anthropic rows export as $0.
  "effectiveCostUsd",
  "durationMs",
] as const

function csvEscape(value: unknown): string {
  if (value == null) return ""
  const s = String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Derived export fields layered on top of the raw row. */
function exportFields(
  r: SessionUsageRow,
  resolve: PricingResolver
): { surface: string; effectiveCostUsd: number } {
  return {
    surface: r.surface ?? "chat",
    effectiveCostUsd: effectiveCostUsd(r, resolve),
  }
}

/**
 * Serialize usage rows to CSV (header row always present). Adds a derived
 * `effectiveCostUsd` (price back-filled when the SDK reported none) and a
 * `surface` column so exports reflect true cost across chat/workflow/team.
 */
export function toUsageCsv(
  rows: readonly SessionUsageRow[],
  resolve: PricingResolver = resolveModelPricingUsd
): string {
  const header = CSV_COLUMNS.join(",")
  if (rows.length === 0) return header
  const body = rows
    .map((r) => {
      const derived = exportFields(r, resolve)
      const merged = { ...r, ...derived } as unknown as Record<string, unknown>
      return CSV_COLUMNS.map((col) => csvEscape(merged[col])).join(",")
    })
    .join("\n")
  return `${header}\n${body}`
}

/**
 * Serialize usage rows to pretty JSON, each augmented with the same derived
 * `surface` + `effectiveCostUsd` fields the CSV carries.
 */
export function toUsageJson(
  rows: readonly SessionUsageRow[],
  resolve: PricingResolver = resolveModelPricingUsd
): string {
  return JSON.stringify(
    rows.map((r) => ({ ...r, ...exportFields(r, resolve) })),
    null,
    2
  )
}

/** `cognia-usage-2026-05-31.csv` style filename, date-stamped from `now`. */
export function buildUsageFilename(format: "csv" | "json", now: number = Date.now()): string {
  const stamp = new Date(now).toISOString().slice(0, 10)
  return `cognia-usage-${stamp}.${format}`
}

export { DAY_MS }
