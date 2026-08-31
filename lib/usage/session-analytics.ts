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

import type { SessionUsageRow, UsageSurface } from "@/lib/db/session-usage"
import { formatCost, type DailyUsage } from "@/types/system/usage"
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

/** Where a turn's effective cost figure came from. */
export type CostSource =
  /** The SDK reported a non-zero `total_cost_usd` — the most accurate figure. */
  | "sdk"
  /** Locally priced from the token breakdown against known rates. */
  | "priced"
  /** No pricing layer knew this model — the accompanying `0` means "unknown". */
  | "unknown"

/** A turn's cost together with whether the number is meaningful. */
export interface EffectiveCost {
  cost: number
  /**
   * `false` only when no pricing layer knew the model. Callers must render an
   * unknown cost as "—" rather than "$0.00": a genuinely free model and a model
   * whose price we simply do not have are both `0`, and conflating them
   * understates spend silently.
   */
  known: boolean
  source: CostSource
}

/**
 * Cost of one turn in USD, with provenance.
 *
 * A row written at v172 or later carries its cost frozen: `costSource` records
 * where the figure came from and `costKnown` whether it means anything. Those
 * rows are returned as stored and NEVER re-priced — that is the entire point of
 * freezing. Re-deriving them against today's rates is what made a price-table
 * edit silently rewrite last year's spend.
 *
 * Older rows (no `costSource`) keep the legacy behaviour: prefer a positive
 * SDK figure, otherwise price the token breakdown at current rates.
 */
export function effectiveCostUsdDetailed(
  row: SessionUsageRow,
  resolve: PricingResolver = resolveModelPricingUsd
): EffectiveCost {
  if (row.costSource !== undefined) {
    // `unknown` and `backfilled` both mean "this 0 is not a price".
    const known = row.costKnown === true
    const source: CostSource = row.costSource === "sdk" ? "sdk" : known ? "priced" : "unknown"
    return { cost: known ? row.costUsd : 0, known, source }
  }

  if (row.costUsd > 0) return { cost: row.costUsd, known: true, source: "sdk" }
  const pricing = resolve(row.providerId, row.model)
  if (pricing === null) return { cost: 0, known: false, source: "unknown" }
  return {
    cost: costFromTokensUsd(
      {
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadInputTokens: row.cacheReadTokens,
        // Legacy rows never carry the TTL split, but pass it when present so a
        // row written between the schema bump and full write-site rollout is
        // still priced with the correct 1-hour rate.
        cacheCreationInputTokens: row.cacheCreationTokens,
        cacheCreation5mInputTokens: row.cacheCreation5mTokens,
        cacheCreation1hInputTokens: row.cacheCreation1hTokens,
        requests: row.unitBreakdown?.requests,
        pages: row.unitBreakdown?.pages,
        characters: row.unitBreakdown?.characters,
        containerHours: row.unitBreakdown?.containerHours,
      },
      pricing
    ),
    known: true,
    source: "priced",
  }
}

/**
 * Cost of one turn in USD. Thin wrapper over {@link effectiveCostUsdDetailed}
 * for summing call sites; returns 0 when the model has no known pricing. Prefer
 * the detailed form anywhere the figure is rendered, so "unknown" stays
 * distinguishable from "free".
 */
export function effectiveCostUsd(
  row: SessionUsageRow,
  resolve: PricingResolver = resolveModelPricingUsd
): number {
  return effectiveCostUsdDetailed(row, resolve).cost
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
  /**
   * Turns whose cost could not be priced by any layer. `costUsd` for those
   * turns contributed 0, so a bucket with `unpricedTurns > 0` is a LOWER BOUND
   * on real spend and must be rendered as such (a "≥" marker or a footnote) —
   * never as a settled figure. 0 means every turn in the bucket was priced.
   */
  unpricedTurns: number
}

/** One usage bucket keyed by producing surface (chat / workflow / agent-team / …). */
export interface SurfaceUsageRow extends Omit<ModelUsageRow, "model"> {
  /** Producing surface; legacy rows with no `surface` are counted as `chat`. */
  surface: UsageSurface
}

/** Fields every bucket accumulates, independent of the grouping axis. */
type UsageBucket = Omit<ModelUsageRow, "model">

function emptyBucket(): UsageBucket {
  return {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    durationMs: 0,
    reasoningTokens: 0,
    unpricedTurns: 0,
  }
}

/**
 * Group rows onto an arbitrary key and sum the billable quantities. The one
 * accumulator behind {@link aggregateByModel} and {@link aggregateBySurface} —
 * two axes over the same rows must never disagree about what a turn cost.
 *
 * Ordering is left to the caller: the natural sort differs per axis (cost for
 * models, cost-then-name for surfaces) and sorting here would force every
 * caller through a second pass.
 */
export function aggregateBucketsBy<K>(
  rows: readonly SessionUsageRow[],
  keyOf: (row: SessionUsageRow) => K,
  resolve: PricingResolver = resolveModelPricingUsd
): Map<K, UsageBucket> {
  const map = new Map<K, UsageBucket>()
  for (const r of rows) {
    const key = keyOf(r)
    const slot = map.get(key) ?? emptyBucket()
    const cost = effectiveCostUsdDetailed(r, resolve)
    slot.turns += 1
    slot.inputTokens += r.inputTokens
    slot.outputTokens += r.outputTokens
    slot.cacheReadTokens += r.cacheReadTokens
    slot.cacheCreationTokens += r.cacheCreationTokens
    slot.costUsd += cost.cost
    slot.durationMs += r.durationMs
    slot.reasoningTokens += r.reasoningTokens ?? 0
    if (!cost.known) slot.unpricedTurns += 1
    map.set(key, slot)
  }
  return map
}

/** Total billable tokens in a bucket — the cost-independent ranking signal. */
export function bucketTokens(
  b: Pick<UsageBucket, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens">
): number {
  return b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheCreationTokens
}

/**
 * Em dash for "we do not know". Never used for a measured zero — a real $0.00
 * (a free or local model) is a fact, and rendering it as "—" would hide it.
 */
export const UNKNOWN_COST = "—"

/**
 * Money for a bucket, honest about provenance.
 *
 * A bucket containing turns that no pricing layer could price contributes 0 for
 * those turns, so its total is a LOWER BOUND and renders with a "≥". A bucket
 * whose turns are ALL unpriced gets no figure at all — "$0.00" would read as
 * free, which is the one thing we know it is not.
 *
 * The single definition behind every aggregate cost read-out: the `/usage`
 * transcript card rendered the marker and the Usage dashboard did not, so the
 * same rows claimed a settled total in one view and a lower bound in the other.
 */
export function formatBucketCost(costUsd: number, unpricedTurns: number, turns: number): string {
  if (turns > 0 && unpricedTurns >= turns) return UNKNOWN_COST
  const base = formatCost(costUsd)
  return unpricedTurns > 0 ? `≥ ${base}` : base
}

/** Bucket rows by model, descending by cost (ties: total tokens, then name). */
export function aggregateByModel(
  rows: readonly SessionUsageRow[],
  resolve: PricingResolver = resolveModelPricingUsd
): ModelUsageRow[] {
  const map = aggregateBucketsBy(rows, (r) => r.model ?? "(unknown)", resolve)
  return [...map.entries()]
    .map(([model, bucket]) => ({ model, ...bucket }))
    .sort(
      (a, b) =>
        b.costUsd - a.costUsd ||
        b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) ||
        a.model.localeCompare(b.model)
    )
}

/**
 * Bucket rows by producing surface, descending by cost (ties: total tokens,
 * then surface name). Legacy rows carry no `surface` and are counted as
 * `"chat"` — the same default every other reader applies.
 *
 * This is the honest answer to "what is using my quota": chat, an agent team,
 * a scheduled workflow and a connector auto-reply all draw on the same plan,
 * and only this axis separates them.
 */
export function aggregateBySurface(
  rows: readonly SessionUsageRow[],
  resolve: PricingResolver = resolveModelPricingUsd
): SurfaceUsageRow[] {
  const map = aggregateBucketsBy(rows, (r) => (r.surface ?? "chat") as UsageSurface, resolve)
  return [...map.entries()]
    .map(([surface, bucket]) => ({ surface, ...bucket }))
    .sort(
      (a, b) =>
        b.costUsd - a.costUsd ||
        bucketTokens(b) - bucketTokens(a) ||
        a.surface.localeCompare(b.surface)
    )
}

/**
 * Format an epoch-ms timestamp as the user's LOCAL "YYYY-MM-DD" day.
 *
 * Same semantics as `lib/db/provider-cost-daily.ts:localDayString`, restated
 * here on purpose: that module imports `getDb` (Dexie) at the top level, and
 * this one is consumed by the CLI (`cli/src/tui/runtime/agent-stats-model.ts`),
 * which must not pull the browser database into its module graph.
 *
 * Exported so every surface that buckets usage by day — the Usage tab's
 * heatmap, the share card's "active days", and the welcome dashboard — agrees
 * on which calendar day a turn belongs to. A second (UTC) definition is exactly
 * how "active days" drifted between two views of the same rows.
 */
export function localDay(at: number): string {
  const d = new Date(at)
  const month = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${d.getFullYear()}-${month}-${day}`
}

/**
 * Inverse of {@link localDay}: read a "YYYY-MM-DD" key back as that day's LOCAL
 * midnight. Shared by the heatmap's cell labels and the streak walk so a day key
 * round-trips through exactly one definition.
 *
 * `||` rather than `??` on the fallbacks: a non-numeric segment parses to NaN,
 * which `??` would pass straight through and turn every derived label into
 * "Invalid Date".
 */
export function parseLocalDay(date: string): Date {
  const [y, m, d] = date.split("-").map(Number)
  return new Date(y || 1970, (m || 1) - 1, d || 1)
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

/**
 * The model that moved the most tokens in `rows`, or `null` when there are
 * none. Volume — not cost — on purpose: this answers "what did I actually work
 * with", which a single expensive turn on a premium model should not win.
 *
 * Shared by the usage share card and the welcome dashboard so both name the
 * same "top model" for the same rows.
 */
export function topModelByTokens(
  rows: readonly SessionUsageRow[],
  resolve: PricingResolver = resolveModelPricingUsd
): string | null {
  const byModel = aggregateByModel(rows, resolve)
  if (byModel.length === 0) return null
  return [...byModel].sort(
    (a, b) =>
      b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) ||
      a.model.localeCompare(b.model)
  )[0].model
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
  /**
   * Turns in this session that no pricing layer could price. Same contract as
   * {@link ModelUsageRow.unpricedTurns}: `costUsd` is a LOWER BOUND whenever
   * this is above zero, so callers must render it through
   * {@link formatBucketCost} rather than as a settled figure.
   *
   * Without it the top-sessions table could only defend itself by filtering on
   * `costUsd > 0`, which silently dropped every session run on an unpriced
   * model — exactly the session someone hunting unexplained spend needs.
   */
  unpricedTurns: number
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
      unpricedTurns: 0,
    }
    const cost = effectiveCostUsdDetailed(r, resolve)
    slot.turns += 1
    slot.tokens += r.inputTokens + r.outputTokens + r.cacheReadTokens
    slot.inputTokens += r.inputTokens
    slot.outputTokens += r.outputTokens
    slot.costUsd += cost.cost
    if (!cost.known) slot.unpricedTurns += 1
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
