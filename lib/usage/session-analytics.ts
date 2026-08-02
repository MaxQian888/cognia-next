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
import type { ModelPricing } from "@cognia/provider-types/provider"
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
  /** Cache-write (creation) tokens — surfaced as a detailed-mode column. */
  cacheCreationTokens: number
  costUsd: number
  /**
   * Sum of SDK-reported active generation time (ms) across this model's turns.
   * 0 when no turn reported a duration (non-SDK paths). Pairs with
   * `outputTokens` to derive throughput via {@link tokensPerSecond}.
   */
  durationMs: number
  /**
   * Sum of reasoning / "thinking" tokens (a subset of `outputTokens`) across
   * this model's turns. 0 when the model / provider never broke them out.
   */
  reasoningTokens: number
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
        cacheCreationTokens: 0,
        costUsd: 0,
        durationMs: 0,
        reasoningTokens: 0,
      } satisfies ModelUsageRow)
    slot.turns += 1
    slot.inputTokens += r.inputTokens
    slot.outputTokens += r.outputTokens
    slot.cacheReadTokens += r.cacheReadTokens
    slot.cacheCreationTokens += r.cacheCreationTokens
    slot.costUsd += effectiveCostUsd(r, resolve)
    slot.durationMs += r.durationMs
    slot.reasoningTokens += r.reasoningTokens ?? 0
    map.set(model, slot)
  }
  return [...map.values()].sort(
    (a, b) =>
      b.costUsd - a.costUsd ||
      b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) ||
      a.model.localeCompare(b.model)
  )
}

/**
 * Format an epoch-ms timestamp as the user's LOCAL "YYYY-MM-DD" day.
 *
 * Same semantics as `lib/db/provider-cost-daily.ts:localDayString`, restated
 * here on purpose: that module imports `getDb` (Dexie) at the top level, and
 * this one is consumed by the CLI (`cli/src/tui/runtime/agent-stats-model.ts`),
 * which must not pull the browser database into its module graph.
 */
function localDay(at: number): string {
  const d = new Date(at)
  const month = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${d.getFullYear()}-${month}-${day}`
}

/** Midnight (local) of the day `daysBack` calendar days before `now`. */
function startOfLocalDay(now: number, daysBack = 0): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - daysBack)
  return d.getTime()
}

/**
 * Bucket rows by the user's LOCAL calendar day, ascending by date. Reuses the
 * `DailyUsage` shape. Local (not UTC) so a turn at 23:00 lands on the day the
 * user remembers spending it, matching the daily cost rollup in
 * `lib/db/provider-cost-daily.ts`.
 *
 * Only days that actually carry usage are emitted — see {@link fillDailyRange}
 * for the gap-filled variant the calendar heatmap needs.
 */
export function aggregateByDay(
  rows: readonly SessionUsageRow[],
  resolve: PricingResolver = resolveModelPricingUsd
): DailyUsage[] {
  const map = new Map<string, DailyUsage>()
  for (const r of rows) {
    const date = localDay(r.at)
    const slot = map.get(date) ?? { date, tokens: 0, cost: 0, requests: 0 }
    slot.tokens += r.inputTokens + r.outputTokens + r.cacheReadTokens
    slot.cost += effectiveCostUsd(r, resolve)
    slot.requests += 1
    map.set(date, slot)
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Pad a sparse {@link aggregateByDay} result out to every local calendar day in
 * the trailing `days`-day window ending today (today counts as one day, so
 * `days: 7` yields today plus the previous six). Days without usage become
 * zero-valued cells.
 *
 * The calendar heatmap needs a dense, strictly-ordered grid — a missing day is
 * a rendered "no spend" square, not a gap — so this always returns exactly
 * `days` entries. Days outside the window are dropped. Pure; `now` injectable.
 */
export function fillDailyRange(
  daily: readonly DailyUsage[],
  days: number,
  now: number = Date.now()
): DailyUsage[] {
  if (!Number.isFinite(days) || days <= 0) return []
  const total = Math.floor(days)
  const byDate = new Map(daily.map((d) => [d.date, d]))
  const cursor = new Date(startOfLocalDay(now, total - 1))
  const out: DailyUsage[] = []
  for (let i = 0; i < total; i += 1) {
    const date = localDay(cursor.getTime())
    out.push(byDate.get(date) ?? { date, tokens: 0, cost: 0, requests: 0 })
    cursor.setDate(cursor.getDate() + 1)
  }
  return out
}

export interface SessionUsageSummary {
  sessionId: string
  turns: number
  tokens: number
  /** Input tokens — surfaced as a detailed-mode column. */
  inputTokens: number
  /** Output tokens — surfaced as a detailed-mode column. */
  outputTokens: number
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
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    }
    slot.turns += 1
    slot.tokens += r.inputTokens + r.outputTokens + r.cacheReadTokens
    slot.inputTokens += r.inputTokens
    slot.outputTokens += r.outputTokens
    slot.costUsd += effectiveCostUsd(r, resolve)
    map.set(r.sessionId, slot)
  }
  return [...map.values()].sort(
    (a, b) => b.costUsd - a.costUsd || b.turns - a.turns || a.sessionId.localeCompare(b.sessionId)
  )
}

/* ── Contributing-factor insights ─────────────────────────────────────────── */

/** Context size (prompt tokens incl. cache) above which a turn is "long-context". */
export const HIGH_CONTEXT_THRESHOLD = 150_000

/**
 * One "what's contributing to your usage" characteristic. These are *independent*
 * characteristics of the usage in range (not a breakdown that sums to 100%), so
 * each carries its own percentage and is shown only when it actually applies.
 */
export interface UsageContributor {
  id: "high-context" | "automated-surface"
  /** This characteristic's share, 0–100 rounded (% of turns or % of cost). */
  pct: number
}

export interface UsageContributors {
  /** Turns (rows) the analysis ran over. */
  turns: number
  contributors: UsageContributor[]
}

/**
 * Derive Claude-Code-style contributing-factor insights from the in-range
 * `sessionUsage` rows — mirroring the `/usage` "what's contributing" block but
 * from this machine's local data only:
 *
 *  • **high-context** — % of turns whose prompt (input + cache read + cache
 *    write) exceeded {@link HIGH_CONTEXT_THRESHOLD}. Long sessions cost more even
 *    when cached.
 *  • **automated-surface** — % of *cost* that came from non-interactive surfaces
 *    (agent team, workflows, connectors, goals), each of which runs its own
 *    requests. The closest honest proxy for the "subagent-heavy" insight given
 *    the data we persist.
 *
 * Parallel-session share is intentionally omitted — the execution broker is
 * in-memory only, so there is no persisted data to derive it from. Pure.
 */
export function analyzeUsageContributors(
  rows: readonly SessionUsageRow[],
  opts: { highContextThreshold?: number; resolve?: PricingResolver } = {}
): UsageContributors {
  const threshold = opts.highContextThreshold ?? HIGH_CONTEXT_THRESHOLD
  const resolve = opts.resolve ?? resolveModelPricingUsd
  const turns = rows.length
  const contributors: UsageContributor[] = []
  if (turns === 0) return { turns, contributors }

  const highContext = rows.filter(
    (r) => r.inputTokens + r.cacheReadTokens + r.cacheCreationTokens > threshold
  ).length
  const highPct = Math.round((highContext / turns) * 100)
  if (highPct > 0) contributors.push({ id: "high-context", pct: highPct })

  let totalCost = 0
  let automatedCost = 0
  for (const r of rows) {
    const c = effectiveCostUsd(r, resolve)
    totalCost += c
    if ((r.surface ?? "chat") !== "chat") automatedCost += c
  }
  const autoPct = totalCost > 0 ? Math.round((automatedCost / totalCost) * 100) : 0
  if (autoPct > 0) contributors.push({ id: "automated-surface", pct: autoPct })

  return { turns, contributors }
}

/**
 * Keep rows inside the trailing `rangeDays`-day LOCAL calendar window ending
 * today — today counts as one day, so `7` means today plus the previous six,
 * cut at local midnight rather than at "now minus 168 hours". This is the same
 * window {@link fillDailyRange} paints, so the filtered rows and the heatmap
 * cells can never disagree about which days are in range. `null` keeps all.
 */
export function filterByRange(
  rows: readonly SessionUsageRow[],
  rangeDays: number | null,
  now: number = Date.now()
): SessionUsageRow[] {
  if (rangeDays == null) return [...rows]
  const cutoff = startOfLocalDay(now, Math.max(0, Math.floor(rangeDays) - 1))
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
  "reasoningTokens",
  "contextInputTokens",
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
