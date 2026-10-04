/**
 * Second-order analytics over `sessionUsage` rows: the figures that turn the
 * Usage dashboard from "what did I spend" into "is that more than usual, where
 * is it heading, and what is it made of".
 *
 * Every function builds on the first-order accumulators in
 * `session-analytics.ts` and `usage-report.ts` rather than re-summing rows, so
 * a delta, a forecast or a percentile can never disagree with the headline
 * total it sits beside. The same honesty rules apply here as there:
 *
 *  - a cost that contains unpriced turns is a LOWER BOUND, so it is never
 *    compared against another period as though it were settled;
 *  - a figure the data cannot support is `null` (rendered "—"), never `0`;
 *  - estimates say they are estimates (cache savings are priced against the
 *    model's rates, not reported by the provider).
 *
 * Industry prior art for the shape of each read-out: period-over-period deltas
 * and spend forecasts (cloud billing consoles, the OpenAI and Anthropic usage
 * pages), cache savings (Helicone, the Anthropic console), latency and cost
 * percentiles (Langfuse, Vercel AI Gateway), and a weekday × hour punch card
 * (GitHub, ccusage-style activity reports). No code was ported.
 *
 * Side-effect-free and clock-injectable. The CLI imports `session-analytics`,
 * so this module must stay free of Dexie and React as well.
 */

import type { SessionUsageRow } from "@/lib/db/session-usage"
import { DEFAULT_CACHE_READ_MULT, resolveModelPricingUsd } from "@/lib/usage/pricing"
import {
  DAY_MS,
  aggregateBucketsBy,
  bucketTokens,
  effectiveCostUsdDetailed,
  localDay,
  startOfLocalDay,
  type PricingResolver,
} from "@/lib/usage/session-analytics"
import type { UsageSpendTotals } from "@/lib/usage/usage-report"
import { percentilesOf } from "@/lib/observability/percentiles"
import type { DailyUsage } from "@/types/system/usage"

/* ── Period-over-period ───────────────────────────────────────────────── */

/** Relative change of one figure between two equal-length windows. */
export interface SpendChange {
  /**
   * Relative cost change (0.25 = +25%). `null` when the previous window spent
   * nothing, or when either window holds unpriced turns: two lower bounds
   * cannot be subtracted into a meaningful trend.
   */
  cost: number | null
  /** Relative change in billable tokens, `null` when the previous window had none. */
  tokens: number | null
  /** Relative change in turns, `null` when the previous window had none. */
  turns: number | null
  /** Relative change in average cost per turn; same comparability rule as `cost`. */
  costPerTurn: number | null
  /** Cache-hit-rate change in percentage POINTS, `null` unless both windows cached. */
  cacheHitPoints: number | null
  /** Relative change in output tokens per second, `null` unless both windows were timed. */
  speed: number | null
}

function relativeChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null
  return (current - previous) / previous
}

function outputSpeed(t: UsageSpendTotals): number {
  return t.durationMs > 0 && t.outputTokens > 0 ? t.outputTokens / (t.durationMs / 1000) : 0
}

function totalTokens(t: UsageSpendTotals): number {
  return t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheCreationTokens
}

/**
 * Compare two {@link UsageSpendTotals}. Pure arithmetic over totals the caller
 * already computed with `summarizeSpend`, so the delta under a headline tile is
 * derived from exactly the number printed in it.
 */
export function compareSpend(current: UsageSpendTotals, previous: UsageSpendTotals): SpendChange {
  const costComparable =
    current.unpricedTurns === 0 && previous.unpricedTurns === 0 && previous.turns > 0
  const perTurn = (t: UsageSpendTotals) => (t.turns > 0 ? t.costUsd / t.turns : 0)
  return {
    cost: costComparable ? relativeChange(current.costUsd, previous.costUsd) : null,
    tokens: relativeChange(totalTokens(current), totalTokens(previous)),
    turns: relativeChange(current.turns, previous.turns),
    costPerTurn:
      costComparable && current.turns > 0
        ? relativeChange(perTurn(current), perTurn(previous))
        : null,
    cacheHitPoints:
      current.cacheHitRate != null && previous.cacheHitRate != null
        ? (current.cacheHitRate - previous.cacheHitRate) * 100
        : null,
    speed:
      outputSpeed(current) > 0 ? relativeChange(outputSpeed(current), outputSpeed(previous)) : null,
  }
}

/* ── Month-end forecast ───────────────────────────────────────────────── */

/** How the daily run rate behind a forecast was measured. */
export type ForecastBasis =
  /** The full trailing seven local days carried data. */
  | "trailing-7d"
  /** First use is newer than seven days, so the window starts there. */
  | "since-first-use"

export interface MonthForecast {
  /** Local spend since the first local midnight of this calendar month. */
  monthToDateUsd: number
  /** Local turns this month. */
  turns: number
  /** Turns this month nobody could price; `monthToDateUsd` is then a floor. */
  unpricedTurns: number
  /**
   * USD per day over the rate window, or `null` when the window is too short or
   * holds no priced turn (a rate of "$0/day" would read as free).
   */
  dailyRunRateUsd: number | null
  /** `monthToDateUsd` plus the run rate over the rest of the month, or `null`. */
  projectedMonthUsd: number | null
  /** Where the run rate came from; `null` alongside a `null` rate. */
  basis: ForecastBasis | null
  /** Length of the run-rate window in days (fractional: today is partial). */
  rateWindowDays: number
  /** Local midnight that opens the month, and the one that opens the next. */
  monthStart: number
  monthEnd: number
}

/**
 * Shortest window a run rate is extrapolated from. Below a day, ten minutes of
 * heavy use on the first morning would project into a month-sized bill.
 */
export const MIN_FORECAST_WINDOW_DAYS = 1

/** Trailing window the run rate is measured over. */
export const FORECAST_RATE_DAYS = 7

function monthBounds(now: number): { start: number; end: number } {
  const d = new Date(now)
  return {
    start: new Date(d.getFullYear(), d.getMonth(), 1).getTime(),
    end: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime(),
  }
}

/** Earliest instant {@link forecastMonthSpend} needs rows from. */
export function forecastQueryStart(now: number): number {
  return Math.min(monthBounds(now).start, startOfLocalDay(now, FORECAST_RATE_DAYS - 1))
}

/**
 * Project this calendar month's local spend.
 *
 * The run rate is spend over the trailing seven local days divided by the time
 * that window actually covers, so a partial today is weighted as a partial day
 * rather than as a full one. Imported rows are dropped: they were paid
 * elsewhere and are already excluded from the budget this is measured against.
 *
 * Pass every row since {@link forecastQueryStart}; earlier rows are ignored.
 */
export function forecastMonthSpend(
  rows: readonly SessionUsageRow[],
  now: number = Date.now(),
  resolve: PricingResolver = resolveModelPricingUsd
): MonthForecast {
  const { start: monthStart, end: monthEnd } = monthBounds(now)
  const rateStart = startOfLocalDay(now, FORECAST_RATE_DAYS - 1)
  let monthToDateUsd = 0
  let turns = 0
  let unpricedTurns = 0
  let rateSpend = 0
  let ratePricedTurns = 0
  let firstAt = Number.POSITIVE_INFINITY

  for (const row of rows) {
    // `isLocalSpend` restated: that predicate lives beside Dexie in
    // `lib/db/session-usage.ts`, which this module must not import.
    if (row.imported === true || row.at > now) continue
    const cost = effectiveCostUsdDetailed(row, resolve)
    if (row.at >= monthStart) {
      monthToDateUsd += cost.cost
      turns += 1
      if (!cost.known) unpricedTurns += 1
    }
    if (row.at >= rateStart) {
      rateSpend += cost.cost
      if (cost.known) ratePricedTurns += 1
      if (row.at < firstAt) firstAt = row.at
    }
  }

  const windowStart = Number.isFinite(firstAt)
    ? Math.max(rateStart, startOfLocalDay(firstAt))
    : rateStart
  const rateWindowDays = Math.max(0, (now - windowStart) / DAY_MS)
  const enough =
    Number.isFinite(firstAt) && rateWindowDays >= MIN_FORECAST_WINDOW_DAYS && ratePricedTurns > 0
  const dailyRunRateUsd = enough ? rateSpend / rateWindowDays : null
  const remainingDays = Math.max(0, (monthEnd - now) / DAY_MS)

  return {
    monthToDateUsd,
    turns,
    unpricedTurns,
    dailyRunRateUsd,
    projectedMonthUsd:
      dailyRunRateUsd == null ? null : monthToDateUsd + dailyRunRateUsd * remainingDays,
    basis: !enough ? null : windowStart > rateStart ? "since-first-use" : "trailing-7d",
    rateWindowDays,
    monthStart,
    monthEnd,
  }
}

/**
 * When the current run rate crosses `limitUsd`, or `null` when it does not
 * within this month (or there is no rate, or the limit is already behind us).
 */
export function projectedLimitCrossing(
  forecast: MonthForecast,
  limitUsd: number,
  now: number = Date.now()
): number | null {
  const rate = forecast.dailyRunRateUsd
  if (rate == null || rate <= 0 || !(limitUsd > 0)) return null
  const headroom = limitUsd - forecast.monthToDateUsd
  if (headroom <= 0) return null
  const at = now + (headroom / rate) * DAY_MS
  return at < forecast.monthEnd ? at : null
}

/* ── Cache savings ────────────────────────────────────────────────────── */

export interface CacheSavings {
  /** Estimated USD the cache reads did not cost compared with fresh input. */
  savedUsd: number
  /** Cache-read tokens that could be priced. */
  pricedReadTokens: number
  /** Cache-read tokens on models with no known input rate. */
  unpricedReadTokens: number
  /**
   * `savedUsd / (spent + savedUsd)`: how much smaller the bill is than it would
   * have been without caching. `null` when nothing was saved or spent.
   */
  savingsRate: number | null
}

/**
 * Estimate what prompt caching saved: each cache-read token billed at the
 * cached-input rate instead of the base input rate. Uses the rates frozen on
 * the row when it has them, so an old turn is valued at the price it was
 * actually charged; otherwise the current resolver. A model whose base rate is
 * unknown contributes to `unpricedReadTokens`, never to the saving.
 */
export function estimateCacheSavings(
  rows: readonly SessionUsageRow[],
  resolve: PricingResolver = resolveModelPricingUsd
): CacheSavings {
  let savedUsd = 0
  let spentUsd = 0
  let pricedReadTokens = 0
  let unpricedReadTokens = 0
  for (const row of rows) {
    spentUsd += effectiveCostUsdDetailed(row, resolve).cost
    const reads = row.cacheReadTokens
    if (!(reads > 0)) continue
    const snapshot = row.priceSnapshot
    const pricing = snapshot?.promptPer1M != null ? null : resolve(row.providerId, row.model)
    const base = snapshot?.promptPer1M ?? pricing?.promptPer1M
    if (base == null || !(base > 0)) {
      unpricedReadTokens += reads
      continue
    }
    const cached =
      snapshot?.cachedInputPer1M ?? pricing?.cachedInputPer1M ?? base * DEFAULT_CACHE_READ_MULT
    const multiplier = snapshot?.rateMultiplier ?? 1
    savedUsd += (reads * Math.max(0, base - cached) * multiplier) / 1_000_000
    pricedReadTokens += reads
  }
  const whole = spentUsd + savedUsd
  return {
    savedUsd,
    pricedReadTokens,
    unpricedReadTokens,
    savingsRate: savedUsd > 0 && whole > 0 ? savedUsd / whole : null,
  }
}

/* ── Stacked daily series ─────────────────────────────────────────────── */

/** Series key that collects every bucket past the top `limit`. */
export const OTHER_SERIES_KEY = "__other__"

export interface DailyStackDay {
  /** Local `YYYY-MM-DD`. */
  date: string
  /** Cost per series key on that day; every key is present, zero-filled. */
  values: Record<string, number>
  total: number
}

export interface DailyStack {
  /** Series keys, largest first, with {@link OTHER_SERIES_KEY} last if used. */
  keys: string[]
  /** One entry per local day in the range, oldest first. */
  days: DailyStackDay[]
}

/**
 * Daily cost split onto an axis (model, surface, provider), for a stacked bar.
 * The top `limit` keys by range cost keep their own series and the rest fold
 * into one "other" series, so the chart stays legible however many models a
 * month touched. The day grid is dense, matching `fillDailyRange`.
 */
export function buildDailyStack(
  rows: readonly SessionUsageRow[],
  keyOf: (row: SessionUsageRow) => string,
  rangeDays: number,
  now: number = Date.now(),
  opts: { limit?: number; resolve?: PricingResolver } = {}
): DailyStack {
  const limit = Math.max(1, opts.limit ?? 5)
  const resolve = opts.resolve ?? resolveModelPricingUsd
  const days = Math.max(1, Math.floor(rangeDays))

  const ranked = [...aggregateBucketsBy(rows, keyOf, resolve).entries()].sort(
    ([ka, a], [kb, b]) =>
      b.costUsd - a.costUsd || bucketTokens(b) - bucketTokens(a) || ka.localeCompare(kb)
  )
  const kept = ranked.slice(0, limit).map(([key]) => key)
  const keptSet = new Set(kept)
  const keys = ranked.length > limit ? [...kept, OTHER_SERIES_KEY] : kept

  const byDay = new Map<string, DailyStackDay>()
  const cursor = new Date(startOfLocalDay(now, days - 1))
  const grid: DailyStackDay[] = []
  for (let i = 0; i < days; i += 1) {
    const date = localDay(cursor.getTime())
    const day: DailyStackDay = {
      date,
      values: Object.fromEntries(keys.map((k) => [k, 0])),
      total: 0,
    }
    grid.push(day)
    byDay.set(date, day)
    cursor.setDate(cursor.getDate() + 1)
  }

  for (const row of rows) {
    const day = byDay.get(localDay(row.at))
    if (!day) continue
    const raw = keyOf(row)
    const key = keptSet.has(raw) ? raw : OTHER_SERIES_KEY
    if (!(key in day.values)) continue
    const cost = effectiveCostUsdDetailed(row, resolve).cost
    day.values[key] += cost
    day.total += cost
  }
  return { keys, days: grid }
}

/* ── Weekday × hour activity ──────────────────────────────────────────── */

export interface ActivityMatrix {
  /** `turns[weekday][hour]`, weekday as `Date#getDay()` (0 = Sunday). */
  turns: number[][]
  /** Same grid, summed effective cost. */
  costUsd: number[][]
  maxTurns: number
  /** Busiest cell by turns; ties go to the earlier weekday, then hour. */
  peak: { weekday: number; hour: number; turns: number } | null
}

/** Fold rows into a 7 × 24 local weekday/hour grid. */
export function buildActivityMatrix(
  rows: readonly SessionUsageRow[],
  resolve: PricingResolver = resolveModelPricingUsd
): ActivityMatrix {
  const turns = Array.from({ length: 7 }, () => new Array<number>(24).fill(0))
  const costUsd = Array.from({ length: 7 }, () => new Array<number>(24).fill(0))
  for (const row of rows) {
    const d = new Date(row.at)
    const w = d.getDay()
    const h = d.getHours()
    turns[w][h] += 1
    costUsd[w][h] += effectiveCostUsdDetailed(row, resolve).cost
  }
  let maxTurns = 0
  let peak: ActivityMatrix["peak"] = null
  for (let w = 0; w < 7; w += 1) {
    for (let h = 0; h < 24; h += 1) {
      if (turns[w][h] > maxTurns) {
        maxTurns = turns[w][h]
        peak = { weekday: w, hour: h, turns: maxTurns }
      }
    }
  }
  return { turns, costUsd, maxTurns, peak }
}

/* ── Per-turn distribution ────────────────────────────────────────────── */

export interface Percentiles {
  p50: number
  p90: number
  p99: number
  max: number
  /** Samples the percentiles were computed over. */
  count: number
}

function percentilesOrNull(values: number[]): Percentiles | null {
  if (values.length === 0) return null
  const [p50, p90, p99, max] = percentilesOf(values, [0.5, 0.9, 0.99, 1])
  return { p50, p90, p99, max, count: values.length }
}

export interface TurnDistribution {
  /** Cost per PRICED turn. Unpriced turns are excluded, not counted as $0. */
  costPerTurn: Percentiles | null
  /** Generation time per turn that reported one. */
  latencyMs: Percentiles | null
  /** Output tokens per second, per turn that reported both figures. */
  outputTokensPerSec: Percentiles | null
}

/**
 * Percentiles of the per-turn figures. An average hides the long tail that
 * actually drives a bill (one 400k-context turn costs as much as fifty small
 * ones), which is why every serious LLM observability tool shows p50/p90/p99.
 */
export function summarizeTurnDistribution(
  rows: readonly SessionUsageRow[],
  resolve: PricingResolver = resolveModelPricingUsd
): TurnDistribution {
  const costs: number[] = []
  const latencies: number[] = []
  const speeds: number[] = []
  for (const row of rows) {
    const cost = effectiveCostUsdDetailed(row, resolve)
    if (cost.known) costs.push(cost.cost)
    if (row.durationMs > 0) {
      latencies.push(row.durationMs)
      if (row.outputTokens > 0) speeds.push(row.outputTokens / (row.durationMs / 1000))
    }
  }
  return {
    costPerTurn: percentilesOrNull(costs),
    latencyMs: percentilesOrNull(latencies),
    outputTokensPerSec: percentilesOrNull(speeds),
  }
}

/* ── Spend spikes ─────────────────────────────────────────────────────── */

export interface SpendSpike {
  /** Local `YYYY-MM-DD`. */
  date: string
  costUsd: number
  /** Median cost of the range's active days. */
  medianUsd: number
  /** `costUsd / medianUsd`. */
  ratio: number
}

export interface SpikeOptions {
  /** Active days required before a median means anything. */
  minActiveDays?: number
  /** How many medians a day must reach to count. */
  factor?: number
  /** Absolute floor, so cents-level noise on a quiet account never alerts. */
  minExcessUsd?: number
  limit?: number
}

/**
 * Days whose spend stands far above the range's typical active day. Median
 * rather than mean so the spike itself cannot inflate the baseline it is
 * measured against. Deterministic: the same days always yield the same list.
 */
export function detectSpendSpikes(
  daily: readonly DailyUsage[],
  opts: SpikeOptions = {}
): SpendSpike[] {
  const minActiveDays = opts.minActiveDays ?? 7
  const factor = opts.factor ?? 2.5
  const minExcessUsd = opts.minExcessUsd ?? 0.5
  const limit = opts.limit ?? 3
  const active = daily.filter((d) => d.cost > 0)
  if (active.length < minActiveDays) return []
  const [medianUsd] = percentilesOf(
    active.map((d) => d.cost),
    [0.5]
  )
  if (!(medianUsd > 0)) return []
  return active
    .filter((d) => d.cost >= medianUsd * factor && d.cost - medianUsd >= minExcessUsd)
    .map((d) => ({ date: d.date, costUsd: d.cost, medianUsd, ratio: d.cost / medianUsd }))
    .sort((a, b) => b.ratio - a.ratio || a.date.localeCompare(b.date))
    .slice(0, limit)
}
