/**
 * Pure derivation rules for the public status contract (v1).
 *
 * Every consumer computes availability, freshness and display status with the
 * functions here, so the Worker that writes a snapshot and the page that reads
 * one cannot disagree about what "unknown", "stale" or "99.9 %" means. Leaf
 * module: no React, no `@/` alias, no Node built-in.
 *
 * Semantics (plan §5):
 * - Missing evidence is `unknown`, never a pass. No observed slot means a null
 *   availability, not 100.
 * - Availability is `pass / (pass + fail)` over summed counts; coverage is
 *   `(pass + fail) / expected`. Rounding happens only for display.
 * - Unknown has no severity number, so it cannot hide behind "operational".
 */

import {
  DAY_MS,
  HOUR_MS,
  LATENCY_BUCKET_BOUNDS_MS,
  LATENCY_BUCKET_COUNT,
  LATENCY_MIN_SAMPLES,
  MINUTE_MS,
  OUTAGE_CONSECUTIVE_FAILURES,
  RANGE_SPECS,
  RECOVERY_CONSECUTIVE_PASSES,
  SEQUENCE_BREAK_MISSING_SLOTS,
  type AvailabilityCounts,
  type AvailabilitySummary,
  type CheckResult,
  type Confidence,
  type DisplayStatus,
  type HistoryRange,
  type LatencyBucket,
  type LocalizedText,
  type MonitoringStatus,
  type ProbeHealth,
  type ProbeSource,
  type ProfileId,
  type ReasonCode,
  type StatusLocale,
} from "./contract"

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * A run scheduled for minute `m` may take up to 20 s and then has to be
 * ingested and aggregated, so its slot only counts as expected once this much
 * time has passed after the minute ends.
 */
export const SLOT_GRACE_MS = MINUTE_MS

export function toIso(ms: number): string {
  return new Date(ms).toISOString()
}

/** The UTC minute a scheduled time belongs to. Never chosen from ingestion time. */
export function minuteOf(ms: number): number {
  return Math.floor(ms / MINUTE_MS)
}

export function hourOf(ms: number): number {
  return Math.floor(ms / HOUR_MS)
}

export function dayOf(ms: number): number {
  return Math.floor(ms / DAY_MS)
}

/** Exclusive end minute of the slots that are due at `nowMs`. */
export function dueEndMinute(nowMs: number): number {
  return minuteOf(nowMs - SLOT_GRACE_MS)
}

export function isMinuteAligned(ms: number): boolean {
  return Number.isFinite(ms) && ms % MINUTE_MS === 0
}

export function parseIsoMs(value: string): number | null {
  // `Date.parse` accepts many shapes; the contract only uses full ISO strings.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return null
  }
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

export interface TimeBucket {
  startMs: number
  endMs: number
}

/**
 * The UTC-aligned buckets a history range shows, oldest first. The last
 * bucket contains `nowMs` and is therefore partial.
 */
export function enumerateRangeBuckets(range: HistoryRange, nowMs: number): TimeBucket[] {
  const spec = RANGE_SPECS[range]
  const lastStart = Math.floor(nowMs / spec.bucketMs) * spec.bucketMs
  return Array.from({ length: spec.buckets }, (_, index) => {
    const startMs = lastStart - (spec.buckets - 1 - index) * spec.bucketMs
    return { startMs, endMs: startMs + spec.bucketMs }
  })
}

/**
 * Expected reference minutes inside `[bucket.startMs, bucket.endMs)` given
 * when observation started and which slots are due. Before observation
 * started nothing is expected, which is a no-data cell, not a pass.
 */
export function expectedMinutesInBucket(
  bucket: TimeBucket,
  observationStartMinute: number | null,
  nowMs: number
): { fromMinute: number; toMinute: number; count: number } {
  if (observationStartMinute === null) return { fromMinute: 0, toMinute: 0, count: 0 }
  const fromMinute = Math.max(minuteOf(bucket.startMs), observationStartMinute)
  const toMinute = Math.min(minuteOf(bucket.endMs), dueEndMinute(nowMs))
  return { fromMinute, toMinute, count: Math.max(0, toMinute - fromMinute) }
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export function observedAvailability(counts: Pick<AvailabilityCounts, "passCount" | "failCount">) {
  const observed = counts.passCount + counts.failCount
  return observed === 0 ? null : (100 * counts.passCount) / observed
}

export function coveragePercent(counts: AvailabilityCounts): number | null {
  if (counts.expectedSlots === 0) return null
  return (100 * (counts.passCount + counts.failCount)) / counts.expectedSlots
}

export interface RawSlotCounts {
  passCount: number
  failCount: number
  expectedSlots: number
  /** Expected slots whose minute falls in an exclusion window. */
  excludedSlots: number
  /** Pass / fail counts inside excluded minutes (removed for the adjusted view). */
  excludedPassCount: number
  excludedFailCount: number
}

export function emptySlotCounts(): RawSlotCounts {
  return {
    passCount: 0,
    failCount: 0,
    expectedSlots: 0,
    excludedSlots: 0,
    excludedPassCount: 0,
    excludedFailCount: 0,
  }
}

export function addSlotCounts(left: RawSlotCounts, right: RawSlotCounts): RawSlotCounts {
  return {
    passCount: left.passCount + right.passCount,
    failCount: left.failCount + right.failCount,
    expectedSlots: left.expectedSlots + right.expectedSlots,
    excludedSlots: left.excludedSlots + right.excludedSlots,
    excludedPassCount: left.excludedPassCount + right.excludedPassCount,
    excludedFailCount: left.excludedFailCount + right.excludedFailCount,
  }
}

/**
 * Turn summed counts into the published summary. Totals are always computed
 * from counts, never by averaging per-day percentages.
 */
export function summarizeAvailability(counts: RawSlotCounts): AvailabilitySummary {
  const observed = counts.passCount + counts.failCount
  const raw: AvailabilityCounts = {
    passCount: counts.passCount,
    failCount: counts.failCount,
    expectedSlots: counts.expectedSlots,
    unknownCount: Math.max(0, counts.expectedSlots - observed),
  }
  const adjustedPass = counts.passCount - counts.excludedPassCount
  const adjustedFail = counts.failCount - counts.excludedFailCount
  const adjustedExpected = counts.expectedSlots - counts.excludedSlots
  const adjusted: AvailabilityCounts = {
    passCount: adjustedPass,
    failCount: adjustedFail,
    expectedSlots: adjustedExpected,
    unknownCount: Math.max(0, adjustedExpected - adjustedPass - adjustedFail),
  }
  return {
    ...raw,
    observedAvailability: observedAvailability(raw),
    coverage: coveragePercent(raw),
    excludedSlots: counts.excludedSlots,
    maintenanceAdjusted: {
      ...adjusted,
      observedAvailability: observedAvailability(adjusted),
      coverage: coveragePercent(adjusted),
    },
  }
}

/**
 * Colour of one history cell. No observation is `no_data`. Failures inside a
 * maintenance exclusion with no failure outside it read as maintenance; any
 * failure outside one is graded by the adjusted availability.
 */
export function bucketStatus(summary: AvailabilitySummary): DisplayStatus | "no_data" {
  const observed = summary.passCount + summary.failCount
  if (summary.expectedSlots === 0 || observed === 0) return "no_data"
  const adjusted = summary.maintenanceAdjusted
  if (summary.failCount === 0) return "operational"
  if (adjusted.failCount === 0) return "maintenance"
  const availability = adjusted.observedAvailability ?? 0
  if (availability >= 99) return "degraded"
  if (availability >= 95) return "partial_outage"
  return "major_outage"
}

/**
 * One minute of the overall series. Any observed failure fails the minute;
 * all three passing passes it; anything else (including data passing while
 * auth was never attempted) is unknown.
 */
export function joinOverallResult(results: readonly CheckResult[]): CheckResult {
  if (results.some((result) => result === "fail")) return "fail"
  if (results.length > 0 && results.every((result) => result === "pass")) return "pass"
  return "unknown"
}

/** Format a percentage for display only. Null is rendered by the caller. */
export function formatPercent(value: number | null, digits = 2): string | null {
  if (value === null || !Number.isFinite(value)) return null
  // Never round a non-perfect figure up to 100.
  const factor = 10 ** digits
  const floored = Math.floor(value * factor) / factor
  return floored.toFixed(digits)
}

// ---------------------------------------------------------------------------
// Maintenance exclusion windows
// ---------------------------------------------------------------------------

export interface MinuteWindow {
  /** Inclusive. */
  startMinute: number
  /** Exclusive. */
  endMinute: number
}

/** Union of half-open windows, so overlaps never double-exclude a minute. */
export function mergeMinuteWindows(windows: readonly MinuteWindow[]): MinuteWindow[] {
  const sorted = windows
    .filter((window) => window.endMinute > window.startMinute)
    .slice()
    .sort((left, right) => left.startMinute - right.startMinute)
  const merged: MinuteWindow[] = []
  for (const window of sorted) {
    const last = merged[merged.length - 1]
    if (last && window.startMinute <= last.endMinute) {
      last.endMinute = Math.max(last.endMinute, window.endMinute)
    } else {
      merged.push({ ...window })
    }
  }
  return merged
}

export function isMinuteExcluded(minute: number, merged: readonly MinuteWindow[]): boolean {
  return merged.some((window) => minute >= window.startMinute && minute < window.endMinute)
}

/** How many minutes of `[fromMinute, toMinute)` fall in the merged windows. */
export function excludedMinuteCount(
  fromMinute: number,
  toMinute: number,
  merged: readonly MinuteWindow[]
): number {
  let total = 0
  for (const window of merged) {
    const start = Math.max(fromMinute, window.startMinute)
    const end = Math.min(toMinute, window.endMinute)
    if (end > start) total += end - start
  }
  return total
}

// ---------------------------------------------------------------------------
// Latency histograms
// ---------------------------------------------------------------------------

export type LatencyHistogram = number[]

export function emptyLatencyHistogram(): LatencyHistogram {
  return Array.from({ length: LATENCY_BUCKET_COUNT }, () => 0)
}

export function latencyBucketIndex(durationMs: number): number {
  const index = LATENCY_BUCKET_BOUNDS_MS.findIndex((bound) => durationMs <= bound)
  return index === -1 ? LATENCY_BUCKET_BOUNDS_MS.length : index
}

export function addLatencySample(histogram: LatencyHistogram, durationMs: number): void {
  histogram[latencyBucketIndex(durationMs)] += 1
}

export function mergeLatencyHistograms(
  histograms: ReadonlyArray<readonly number[]>
): LatencyHistogram {
  const merged = emptyLatencyHistogram()
  for (const histogram of histograms) {
    for (let index = 0; index < merged.length; index += 1) {
      merged[index] += histogram[index] ?? 0
    }
  }
  return merged
}

/**
 * The upper bound of the bucket holding the `quantile` sample. Read from a
 * merged histogram, so it is never a percentile of percentiles. The open top
 * bucket reports the last finite bound.
 */
export function histogramPercentile(histogram: readonly number[], quantile: number): number | null {
  const total = histogram.reduce((sum, count) => sum + count, 0)
  if (total === 0) return null
  const rank = Math.max(1, Math.ceil(quantile * total))
  let seen = 0
  for (let index = 0; index < histogram.length; index += 1) {
    seen += histogram[index] ?? 0
    if (seen >= rank) {
      return LATENCY_BUCKET_BOUNDS_MS[Math.min(index, LATENCY_BUCKET_BOUNDS_MS.length - 1)]
    }
  }
  return LATENCY_BUCKET_BOUNDS_MS[LATENCY_BUCKET_BOUNDS_MS.length - 1]
}

export function latencyBucketView(bucket: TimeBucket, histogram: readonly number[]): LatencyBucket {
  const sampleCount = histogram.reduce((sum, count) => sum + count, 0)
  const enough = sampleCount >= LATENCY_MIN_SAMPLES
  return {
    start: toIso(bucket.startMs),
    end: toIso(bucket.endMs),
    sampleCount,
    p50Ms: enough ? histogramPercentile(histogram, 0.5) : null,
    p95Ms: enough ? histogramPercentile(histogram, 0.95) : null,
  }
}

// ---------------------------------------------------------------------------
// Current status from fresh evidence
// ---------------------------------------------------------------------------

/** One expected slot of a witness, newest last. `missing` = nothing arrived. */
export type SlotOutcome = CheckResult | "missing"

export interface WitnessEvidence {
  probeId: string
  profileId: ProfileId
  source: ProbeSource
  reference: boolean
  /** Freshness budget for this witness's cadence. */
  freshMs: number
  latest: { result: CheckResult; reason: ReasonCode | null; checkedAtMs: number } | null
  /** The witness's recent expected slots, oldest first, newest last. */
  recent: readonly SlotOutcome[]
}

export interface Streaks {
  failures: number
  passes: number
  /** Failures immediately before the current pass streak (recovery detection). */
  failuresBeforePasses: number
}

/**
 * Consecutive failures / passes counted back from the newest slot. `unknown`
 * and `missing` slots are gaps: one gap is skipped, two in a row break the
 * sequence, so a delayed batch cannot stitch distant failures together.
 */
export function slotStreaks(recent: readonly SlotOutcome[]): Streaks {
  const count = (from: number, wanted: "pass" | "fail") => {
    let total = 0
    let gapRun = 0
    let index = from
    for (; index >= 0; index -= 1) {
      const outcome = recent[index]
      if (outcome === wanted) {
        total += 1
        gapRun = 0
      } else if (outcome === "unknown" || outcome === "missing") {
        gapRun += 1
        if (gapRun >= SEQUENCE_BREAK_MISSING_SLOTS) break
      } else {
        break
      }
    }
    return { total, stoppedAt: index }
  }
  const failures = count(recent.length - 1, "fail")
  const passes = count(recent.length - 1, "pass")
  const before = passes.total > 0 ? count(passes.stoppedAt, "fail").total : 0
  return { failures: failures.total, passes: passes.total, failuresBeforePasses: before }
}

export function isEvidenceFresh(evidence: WitnessEvidence, nowMs: number): boolean {
  if (!evidence.latest) return false
  const age = nowMs - evidence.latest.checkedAtMs
  return age >= -SLOT_GRACE_MS && age <= evidence.freshMs
}

/** Fresh, and a real pass or fail rather than an unknown. */
function usable(evidence: WitnessEvidence, nowMs: number): boolean {
  return isEvidenceFresh(evidence, nowMs) && evidence.latest?.result !== "unknown"
}

/** Non-reference witnesses need this many consecutive failures to disagree. */
export const WITNESS_REPEATED_FAILURES = 2

export interface ComponentStatusInput {
  /** The designated reference observer for this component (native profile). */
  reference: WitnessEvidence | null
  /** Other observers: corroborating sources and Origin profiles. */
  witnesses: readonly WitnessEvidence[]
  /** A published window with this component in scope is active now. */
  inMaintenance: boolean
  nowMs: number
}

export interface ComponentStatusResult {
  status: DisplayStatus
  confidence: Confidence
  latestEvidenceAtMs: number | null
  /** The witness whose evidence decided the status, for diagnostics. */
  decidedBy: string | null
  referenceStreaks: Streaks
}

/**
 * Plan §5 "Public current state" table, as a pure function.
 *
 * - No usable fresh result anywhere: unknown (even in maintenance).
 * - In maintenance with fresh evidence: maintenance.
 * - Reference passing: operational, unless a fresh witness repeatedly fails
 *   (partial outage) or the pass streak is shorter than the recovery rule
 *   right after an outage (degraded while it settles).
 * - Reference failing: degraded below three consecutive failures, then major
 *   outage, or partial outage while a fresh witness still passes.
 * - Reference stale: the same rules over the best fresh witness.
 */
export function deriveComponentStatus(input: ComponentStatusInput): ComponentStatusResult {
  const { reference, witnesses, inMaintenance, nowMs } = input
  const all = reference ? [reference, ...witnesses] : [...witnesses]
  const latestEvidenceAtMs = all.reduce<number | null>((latest, evidence) => {
    const at = evidence.latest?.checkedAtMs
    if (at === undefined) return latest
    return latest === null || at > latest ? at : latest
  }, null)
  const referenceStreaks = reference
    ? slotStreaks(reference.recent)
    : { failures: 0, passes: 0, failuresBeforePasses: 0 }
  const freshWitnesses = witnesses.filter((evidence) => usable(evidence, nowMs))
  const primary =
    reference && usable(reference, nowMs)
      ? reference
      : // A stale reference: decide from the freshest native witness first.
        (freshWitnesses
          .slice()
          .sort((left, right) => {
            if (left.profileId === "native" && right.profileId !== "native") return -1
            if (right.profileId === "native" && left.profileId !== "native") return 1
            return (right.latest?.checkedAtMs ?? 0) - (left.latest?.checkedAtMs ?? 0)
          })
          .at(0) ?? null)

  if (!primary) {
    return {
      status: "unknown",
      confidence: "none",
      latestEvidenceAtMs,
      decidedBy: null,
      referenceStreaks,
    }
  }

  const others = all.filter((evidence) => evidence !== primary && usable(evidence, nowMs))
  const confidence: Confidence =
    primary === reference && others.some((evidence) => evidence.profileId === "native")
      ? "corroborated"
      : "single_witness"
  const base = { latestEvidenceAtMs, decidedBy: primary.probeId, referenceStreaks }

  if (inMaintenance) return { ...base, status: "maintenance", confidence }

  const streaks = primary === reference ? referenceStreaks : slotStreaks(primary.recent)
  const latest = primary.latest?.result

  if (latest === "pass") {
    const disagreeing = others.some(
      (evidence) =>
        evidence.latest?.result === "fail" &&
        slotStreaks(evidence.recent).failures >= WITNESS_REPEATED_FAILURES
    )
    if (disagreeing) return { ...base, status: "partial_outage", confidence }
    const recovering =
      streaks.passes < RECOVERY_CONSECUTIVE_PASSES &&
      streaks.failuresBeforePasses >= OUTAGE_CONSECUTIVE_FAILURES
    return { ...base, status: recovering ? "degraded" : "operational", confidence }
  }

  // The primary witness fails.
  if (streaks.failures < OUTAGE_CONSECUTIVE_FAILURES) {
    return { ...base, status: "degraded", confidence }
  }
  const passingWitness = others.some((evidence) => evidence.latest?.result === "pass")
  if (passingWitness) return { ...base, status: "partial_outage", confidence }
  const corroboratingFailure = others.some(
    (evidence) =>
      evidence.profileId === "native" &&
      slotStreaks(evidence.recent).failures >= WITNESS_REPEATED_FAILURES
  )
  return {
    ...base,
    status: "major_outage",
    confidence: corroboratingFailure ? "corroborated" : "single_witness",
  }
}

const FAILING_SEVERITY: Partial<Record<DisplayStatus, number>> = {
  degraded: 1,
  partial_outage: 2,
  major_outage: 3,
}

/**
 * Overall service status: the worst failing component wins; otherwise any
 * unknown component makes the whole unknown; otherwise maintenance shows
 * through; otherwise operational. An empty list is unknown.
 */
export function deriveOverallStatus(statuses: readonly DisplayStatus[]): DisplayStatus {
  if (statuses.length === 0) return "unknown"
  let worst: DisplayStatus | null = null
  for (const status of statuses) {
    const severity = FAILING_SEVERITY[status]
    if (severity !== undefined && (worst === null || severity > FAILING_SEVERITY[worst]!)) {
      worst = status
    }
  }
  if (worst) return worst
  if (statuses.includes("unknown")) return "unknown"
  if (statuses.includes("maintenance")) return "maintenance"
  return "operational"
}

/**
 * Observer health, separate from service health. No reference or a reference
 * that is not healthy degrades monitoring; a healthy reference with no other
 * healthy observer is "limited" (single witness).
 */
export function deriveMonitoringStatus(
  probes: ReadonlyArray<{ reference: boolean; health: ProbeHealth }>
): MonitoringStatus {
  const active = probes.filter((probe) => probe.health !== "disabled")
  if (active.length === 0) return "unknown"
  const reference = active.find((probe) => probe.reference)
  if (!reference || reference.health !== "healthy") return "degraded"
  const others = active.filter((probe) => !probe.reference && probe.health === "healthy")
  return others.length === 0 ? "limited" : "healthy"
}

// ---------------------------------------------------------------------------
// Client-side freshness
// ---------------------------------------------------------------------------

export interface SnapshotFreshness {
  ageMs: number
  stale: boolean
  /** The client clock disagrees with the server implausibly; age is uncertain. */
  clockUncertain: boolean
}

/** Beyond this, a generatedAt "in the future" means the clocks disagree. */
export const MAX_PLAUSIBLE_FUTURE_MS = 60_000

/**
 * Age of a snapshot as the browser should show it. The server time observed
 * when the snapshot was fetched calibrates the client clock, so a wrong local
 * clock does not make an old snapshot look fresh.
 */
export function snapshotFreshness(input: {
  generatedAtMs: number
  serverTimeMs: number
  staleAfterMs: number
  /** Client clock when the response arrived. */
  fetchedAtClientMs: number
  /** Client clock now. */
  nowClientMs: number
}): SnapshotFreshness {
  const offset = input.serverTimeMs - input.fetchedAtClientMs
  const serverNow = input.nowClientMs + offset
  const ageMs = serverNow - input.generatedAtMs
  const clockUncertain = ageMs < -MAX_PLAUSIBLE_FUTURE_MS || !Number.isFinite(ageMs)
  return {
    ageMs: Math.max(0, ageMs),
    stale: clockUncertain || ageMs > input.staleAfterMs,
    clockUncertain,
  }
}

// ---------------------------------------------------------------------------
// Localized text
// ---------------------------------------------------------------------------

/** Requested locale, falling back to English when missing or blank. */
export function pickLocalized(text: LocalizedText, locale: string): string {
  if (locale === "zh-CN" || locale.toLowerCase().startsWith("zh")) {
    const zh = text["zh-CN"]
    if (zh && zh.trim().length > 0) return zh
  }
  return text.en
}

export function normalizeStatusLocale(locale: string | null | undefined): StatusLocale {
  return locale && locale.toLowerCase().startsWith("zh") ? "zh-CN" : "en"
}
