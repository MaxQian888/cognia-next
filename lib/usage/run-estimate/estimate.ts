/**
 * Run estimate: what a long run like this one usually costs and takes
 * (ADR-0232).
 *
 * Advisory only. Nothing here gates, reserves or routes a run; the budget
 * mechanisms of ADR-0090 / ADR-0165 / ADR-0188 stay the only enforcement. The
 * number exists so a person launching a `/goal`, a squad, a best-of-N group or
 * a scheduled task has a rough expectation before it finishes.
 *
 * Method, deliberately plain: past runs are bucketed by launch surface ×
 * harness × model family, the finest bucket with enough samples answers, and
 * the answer is a weighted P10 / P50 / P90 over whole runs. There is no
 * learned model. One install produces tens to hundreds of runs, which is
 * enough for empirical quantiles and nowhere near enough for regression.
 *
 * Pure and Dexie-free like the rest of `lib/usage/`; the loader in
 * `load-samples.ts` builds the samples.
 */

import type { PricingResolver } from "@/lib/usage/session-analytics"
import { costFromTokensUsd, resolveModelPricingUsd } from "@/lib/usage/pricing"

import type { RunHarnessKey } from "./harness"

/**
 * Where a long run is launched. `external-session` is never launched: it is
 * the bucket imported Claude Code / Codex transcripts land in, consulted only
 * by launches on the same external harness.
 *
 * `bot` is intentionally dormant. Native bot agent turns write no usage rows,
 * so there is no history to estimate from. It is listed in
 * {@link DORMANT_ESTIMATE_SURFACES}: `useRunEstimate` short-circuits on it and
 * the bot run button's hint renders the "unavailable" sentence, and
 * {@link estimateRun} answers `confidence: "none"` should anything else ask.
 * `estimate.test.ts`, `use-run-estimate.test.ts` and `run-estimate-hint.test.tsx`
 * pin it.
 */
export type RunEstimateSurface =
  "goal" | "team" | "best-of-n" | "scheduled" | "external-session" | "bot"

/** Surfaces with no sample source yet. See {@link RunEstimateSurface}. */
export const DORMANT_ESTIMATE_SURFACES: ReadonlySet<RunEstimateSurface> = new Set(["bot"])

/** Billed token classes of one run, summed over its whole run tree. */
export interface RunTokenBreakdown {
  input: number
  output: number
  cacheRead: number
  /** Cache writes whose TTL was not reported, priced as 5-minute writes. */
  cacheWrite: number
  cacheWrite5m: number
  cacheWrite1h: number
}

/** One finished run, as the estimator sees it. */
export interface RunSample {
  surface: Exclude<RunEstimateSurface, "bot">
  harness: RunHarnessKey | null
  modelFamily: string | null
  /** The model the run spent most tokens on; priced when the query names none. */
  model?: string
  providerId?: string
  /** When the run ended; drives the 90-day window and the decay weight. */
  endedAt: number
  /** Wall-clock duration, or `null` when the source cannot say. */
  durationMs: number | null
  /** `null` when the source keeps only a frozen dollar figure (best-of-N). */
  tokens: RunTokenBreakdown | null
  /** Used only when `tokens` is `null`. `null` when unknown. */
  frozenCostUsd: number | null
  /** Cancelled, failed or limit-stopped. `null` when the source does not say. */
  stoppedEarly: boolean | null
}

export interface RunEstimateQuery {
  surface: RunEstimateSurface
  harness?: RunHarnessKey | null
  /** The model this launch will run on; samples are re-priced at its rates. */
  model?: string | null
  providerId?: string | null
  /** Model family of `model`, precomputed by the caller. */
  modelFamily?: string | null
  /**
   * Runs this launch starts side by side (best-of-N candidates). Tokens and
   * cost scale with it; duration does not, because the runs are parallel.
   */
  multiplier?: number
}

export interface Quantiles {
  p10: number
  p50: number
  p90: number
}

/**
 * `based`: 20 or more comparable runs. `few`: 5–19. `rough`: fewer than 5
 * even after falling back to the coarsest bucket. `none`: nothing to go on.
 */
export type RunEstimateConfidence = "based" | "few" | "rough" | "none"

export interface RunEstimate {
  confidence: RunEstimateConfidence
  /** Runs behind the figures (before weighting). */
  sampleCount: number
  /** `null` when no sample in the chosen bucket carries a token breakdown. */
  tokens: Quantiles | null
  /** USD at today's API rates. `null` when no sample could be priced. */
  costUsd: Quantiles | null
  durationMs: Quantiles | null
  /** Share of comparable runs that stopped early, 0–1, or `null` when unknown. */
  stoppedShare: number | null
}

export const ESTIMATE_WINDOW_MS = 90 * 86_400_000
export const ESTIMATE_HALF_LIFE_MS = 30 * 86_400_000
export const MIN_SAMPLES_FEW = 5
export const MIN_SAMPLES_BASED = 20

export const EMPTY_ESTIMATE: RunEstimate = {
  confidence: "none",
  sampleCount: 0,
  tokens: null,
  costUsd: null,
  durationMs: null,
  stoppedShare: null,
}

interface Weighted {
  value: number
  weight: number
}

/**
 * Weighted quantile by midpoint interpolation: each point sits at the middle
 * of its share of the total weight, and `p` is a fraction of that total. With
 * equal weights this is the Hazen (type-5) percentile; heavier points pull the
 * quantile toward themselves, which is how recent runs count for more.
 */
export function weightedQuantile(points: readonly Weighted[], p: number): number {
  const sorted = points.filter((pt) => pt.weight > 0).sort((a, b) => a.value - b.value)
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0].value
  let cumulative = 0
  const positions = sorted.map((pt) => {
    const mid = cumulative + pt.weight / 2
    cumulative += pt.weight
    return mid
  })
  const target = Math.min(1, Math.max(0, p)) * cumulative
  if (target <= positions[0]) return sorted[0].value
  for (let i = 1; i < sorted.length; i += 1) {
    if (target <= positions[i]) {
      const frac = (target - positions[i - 1]) / (positions[i] - positions[i - 1])
      return sorted[i - 1].value + (sorted[i].value - sorted[i - 1].value) * frac
    }
  }
  return sorted[sorted.length - 1].value
}

function quantiles(points: readonly Weighted[], scale = 1): Quantiles | null {
  if (points.length === 0) return null
  return {
    p10: weightedQuantile(points, 0.1) * scale,
    p50: weightedQuantile(points, 0.5) * scale,
    p90: weightedQuantile(points, 0.9) * scale,
  }
}

/** Half-life decay weight of a run that ended `ageMs` ago. */
export function decayWeight(ageMs: number): number {
  return Math.pow(0.5, Math.max(0, ageMs) / ESTIMATE_HALF_LIFE_MS)
}

function totalTokens(t: RunTokenBreakdown): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite + t.cacheWrite5m + t.cacheWrite1h
}

/**
 * A sample's cost at today's rates for the query's model (or its own model
 * when the query names none). Re-pricing, rather than reading the frozen
 * ledger cost, keeps a price cut or a different model choice from being
 * answered with last quarter's dollars. `null` when no rate is known.
 */
function sampleCostUsd(
  sample: RunSample,
  query: RunEstimateQuery,
  resolve: PricingResolver
): number | null {
  if (!sample.tokens) return sample.frozenCostUsd
  const pricing =
    (query.model ? resolve(query.providerId ?? undefined, query.model) : null) ??
    resolve(sample.providerId, sample.model)
  if (!pricing) return null
  const t = sample.tokens
  return costFromTokensUsd(
    {
      inputTokens: t.input,
      outputTokens: t.output,
      cacheReadInputTokens: t.cacheRead,
      cacheCreationInputTokens: t.cacheWrite,
      cacheCreation5mInputTokens: t.cacheWrite5m,
      cacheCreation1hInputTokens: t.cacheWrite1h,
    },
    pricing
  )
}

type Level = (sample: RunSample) => boolean

/**
 * Buckets from finest to coarsest. A level whose key the query cannot fill is
 * skipped rather than matched against "unknown", so a query with no model
 * never pretends to be a model-specific estimate.
 *
 * Imported transcripts (`external-session`) are consulted only for a query on
 * a concrete external harness, and only after that surface's own history on
 * the harness: they are interactive sessions, not launches of this kind.
 */
function levelsFor(query: RunEstimateQuery): Level[] {
  const { surface, harness, modelFamily } = query
  const levels: Level[] = []
  if (harness && modelFamily) {
    levels.push(
      (s) => s.surface === surface && s.harness === harness && s.modelFamily === modelFamily
    )
  }
  if (harness) levels.push((s) => s.surface === surface && s.harness === harness)
  if (harness?.startsWith("ext:")) {
    if (modelFamily) {
      levels.push(
        (s) =>
          s.surface === "external-session" && s.harness === harness && s.modelFamily === modelFamily
      )
    }
    levels.push((s) => s.surface === "external-session" && s.harness === harness)
  }
  if (!harness && modelFamily) {
    levels.push((s) => s.surface === surface && s.modelFamily === modelFamily)
  }
  levels.push((s) => s.surface === surface)
  return levels
}

export interface EstimateOptions {
  now: number
  resolve?: PricingResolver
}

/**
 * Estimate a launch from past runs. Picks the finest bucket holding at least
 * {@link MIN_SAMPLES_FEW} runs; when none does, answers `rough` from the
 * fullest bucket that has any.
 */
export function estimateRun(
  samples: readonly RunSample[],
  query: RunEstimateQuery,
  { now, resolve = resolveModelPricingUsd }: EstimateOptions
): RunEstimate {
  if (DORMANT_ESTIMATE_SURFACES.has(query.surface)) return EMPTY_ESTIMATE
  const recent = samples.filter((s) => s.endedAt <= now && now - s.endedAt <= ESTIMATE_WINDOW_MS)
  const buckets = levelsFor(query).map((level) => recent.filter(level))
  let chosen = buckets.find((bucket) => bucket.length >= MIN_SAMPLES_FEW)
  if (!chosen) {
    chosen = buckets.reduce<RunSample[]>((best, b) => (b.length > best.length ? b : best), [])
  }
  if (chosen.length === 0) return EMPTY_ESTIMATE

  const multiplier = Math.max(1, query.multiplier ?? 1)
  const tokenPoints: Weighted[] = []
  const costPoints: Weighted[] = []
  const durationPoints: Weighted[] = []
  let stoppedWeight = 0
  let knownStopWeight = 0
  for (const sample of chosen) {
    const weight = decayWeight(now - sample.endedAt)
    if (sample.tokens) tokenPoints.push({ value: totalTokens(sample.tokens), weight })
    const cost = sampleCostUsd(sample, query, resolve)
    if (cost !== null) costPoints.push({ value: cost, weight })
    if (sample.durationMs !== null && sample.durationMs >= 0) {
      durationPoints.push({ value: sample.durationMs, weight })
    }
    if (sample.stoppedEarly !== null) {
      knownStopWeight += weight
      if (sample.stoppedEarly) stoppedWeight += weight
    }
  }

  const n = chosen.length
  return {
    confidence: n >= MIN_SAMPLES_BASED ? "based" : n >= MIN_SAMPLES_FEW ? "few" : "rough",
    sampleCount: n,
    tokens: quantiles(tokenPoints, multiplier),
    costUsd: quantiles(costPoints, multiplier),
    durationMs: quantiles(durationPoints),
    stoppedShare: knownStopWeight > 0 ? stoppedWeight / knownStopWeight : null,
  }
}

/**
 * Sum several estimates of runs launched together (best-of-N candidates on
 * different agents). Quantiles are added, which assumes the candidates' costs
 * move together; for independent candidates that overstates the range's
 * width, an acceptable error for a figure meant as a rough expectation.
 * Duration takes the slowest part, since the parts run in parallel.
 */
export function combineParallelEstimates(parts: readonly RunEstimate[]): RunEstimate {
  if (parts.length === 0) return EMPTY_ESTIMATE
  if (parts.some((part) => part.confidence === "none")) return EMPTY_ESTIMATE
  const order: RunEstimateConfidence[] = ["none", "rough", "few", "based"]
  const confidence = parts.reduce<RunEstimateConfidence>(
    (worst, part) =>
      order.indexOf(part.confidence) < order.indexOf(worst) ? part.confidence : worst,
    "based"
  )
  const sum = (pick: (e: RunEstimate) => Quantiles | null): Quantiles | null => {
    const values = parts.map(pick)
    if (values.some((v) => v === null)) return null
    return (values as Quantiles[]).reduce((acc, q) => ({
      p10: acc.p10 + q.p10,
      p50: acc.p50 + q.p50,
      p90: acc.p90 + q.p90,
    }))
  }
  const durations = parts.map((part) => part.durationMs)
  const shares = parts.map((part) => part.stoppedShare).filter((s): s is number => s !== null)
  return {
    confidence,
    sampleCount: Math.min(...parts.map((part) => part.sampleCount)),
    tokens: sum((e) => e.tokens),
    costUsd: sum((e) => e.costUsd),
    durationMs: durations.some((d) => d === null)
      ? null
      : (durations as Quantiles[]).reduce((acc, q) => ({
          p10: Math.max(acc.p10, q.p10),
          p50: Math.max(acc.p50, q.p50),
          p90: Math.max(acc.p90, q.p90),
        })),
    stoppedShare: shares.length > 0 ? Math.max(...shares) : null,
  }
}
