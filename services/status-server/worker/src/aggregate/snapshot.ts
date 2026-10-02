/**
 * Precomputed public snapshots, one per history range.
 *
 * Built once a minute under the aggregation lease from rollups (never a
 * history scan per visitor) and stored as JSON rows the public read path
 * returns verbatim. `buildSnapshot` is pure so the published semantics —
 * expected / excluded slots, partial buckets, counts-based totals — are
 * tested without D1.
 */

import {
  COMPONENT_IDS,
  COMPONENT_LATENCY_PHASE,
  DAY_MS,
  HOUR_MS,
  LATENCY_MIN_SAMPLES,
  MAX_SNAPSHOT_BYTES,
  MINUTE_MS,
  PROFILE_FRESH_MS,
  RANGE_SPECS,
  REFERENCE_FRESH_MS,
  SNAPSHOT_STALE_MS,
  STATUS_SCHEMA_VERSION,
  HISTORY_RANGES,
  type ComponentId,
  type ComponentSnapshot,
  type HistoryBucket,
  type HistoryRange,
  type IncidentSummary,
  type LatencyBucket,
  type MaintenanceView,
  type ProbeSummary,
  type PublicStatusSnapshot,
  type StatusCapabilities,
} from "../../../../../lib/status/contract"
import {
  addSlotCounts,
  bucketStatus,
  deriveMonitoringStatus,
  deriveOverallStatus,
  emptySlotCounts,
  enumerateRangeBuckets,
  excludedMinuteCount,
  expectedMinutesInBucket,
  latencyBucketView,
  mergeLatencyHistograms,
  summarizeAvailability,
  toIso,
  type MinuteWindow,
  type RawSlotCounts,
  type TimeBucket,
} from "../../../../../lib/status/derive"
import { leaseGuard } from "../platform/lease"
import { logEvent } from "../platform/http"
import { nextCounter } from "../platform/store"
import type { JobContext } from "../seams"
import type { EvaluatedComponent } from "./evaluate"
import type { CountRollup, ExclusionWindows, Rollup } from "./rollup"

/** Latency percentiles never look back further than hourly retention allows. */
export const LATENCY_SUMMARY_MAX_MS = 7 * DAY_MS

export interface SnapshotInputs {
  nowMs: number
  revision: number
  range: HistoryRange
  observationStartMinute: number | null
  hourly: ReadonlyMap<number, Rollup>
  daily: ReadonlyMap<number, Rollup>
  exclusions: { perComponent: ExclusionWindows; overall: MinuteWindow[] }
  evaluated: readonly EvaluatedComponent[]
  probes: ProbeSummary[]
  incidents: { active: IncidentSummary[]; past: IncidentSummary[] }
  maintenance: MaintenanceView[]
  capabilities: StatusCapabilities
}

function bucketCounts(
  bucket: TimeBucket,
  counts: CountRollup | undefined,
  windows: readonly MinuteWindow[],
  observationStartMinute: number | null,
  nowMs: number
): RawSlotCounts {
  const expected = expectedMinutesInBucket(bucket, observationStartMinute, nowMs)
  const pass = counts?.p ?? 0
  const fail = counts?.f ?? 0
  // A run for a minute that is not yet "due" may already have arrived; an
  // observed minute is always an expected one, so coverage never exceeds 100.
  const expectedSlots = Math.max(expected.count, pass + fail)
  const excludedSlots = Math.min(
    expectedSlots,
    Math.max(
      excludedMinuteCount(expected.fromMinute, expected.toMinute, windows),
      (counts?.xp ?? 0) + (counts?.xf ?? 0)
    )
  )
  return {
    passCount: pass,
    failCount: fail,
    expectedSlots,
    excludedSlots,
    excludedPassCount: counts?.xp ?? 0,
    excludedFailCount: counts?.xf ?? 0,
  }
}

function rollupForBucket(
  range: HistoryRange,
  bucket: TimeBucket,
  hourly: ReadonlyMap<number, Rollup>,
  daily: ReadonlyMap<number, Rollup>
): Rollup | undefined {
  return range === "24h"
    ? hourly.get(Math.floor(bucket.startMs / HOUR_MS))
    : daily.get(Math.floor(bucket.startMs / DAY_MS))
}

function historyFor(
  inputs: SnapshotInputs,
  pick: (rollup: Rollup | undefined) => CountRollup | undefined,
  windows: readonly MinuteWindow[]
): { buckets: HistoryBucket[]; total: RawSlotCounts } {
  const startMs =
    inputs.observationStartMinute === null ? null : inputs.observationStartMinute * MINUTE_MS
  let total = emptySlotCounts()
  const buckets = enumerateRangeBuckets(inputs.range, inputs.nowMs).map((bucket) => {
    const counts = bucketCounts(
      bucket,
      pick(rollupForBucket(inputs.range, bucket, inputs.hourly, inputs.daily)),
      windows,
      inputs.observationStartMinute,
      inputs.nowMs
    )
    total = addSlotCounts(total, counts)
    const availability = summarizeAvailability(counts)
    const partial =
      (inputs.nowMs >= bucket.startMs && inputs.nowMs < bucket.endMs) ||
      (startMs !== null && startMs > bucket.startMs && startMs < bucket.endMs)
    return {
      start: toIso(bucket.startMs),
      end: toIso(bucket.endMs),
      partial,
      status: bucketStatus(availability),
      availability,
    }
  })
  return { buckets, total }
}

function latencyFor(
  inputs: SnapshotInputs,
  componentId: ComponentId
): ComponentSnapshot["latency"] {
  const hourBuckets = enumerateRangeBuckets("24h", inputs.nowMs)
  const buckets: LatencyBucket[] = hourBuckets.map((bucket) =>
    latencyBucketView(
      bucket,
      inputs.hourly.get(Math.floor(bucket.startMs / HOUR_MS))?.c[componentId].h ?? []
    )
  )
  const spanMs = Math.min(RANGE_SPECS[inputs.range].durationMs, LATENCY_SUMMARY_MAX_MS)
  const fromHour = Math.floor((inputs.nowMs - spanMs) / HOUR_MS) + 1
  const toHour = Math.floor(inputs.nowMs / HOUR_MS)
  const histograms: number[][] = []
  for (let hour = fromHour; hour <= toHour; hour += 1) {
    const histogram = inputs.hourly.get(hour)?.c[componentId].h
    if (histogram) histograms.push(histogram)
  }
  return {
    phase: COMPONENT_LATENCY_PHASE[componentId],
    minSamples: LATENCY_MIN_SAMPLES,
    summary: latencyBucketView(
      { startMs: fromHour * HOUR_MS, endMs: (toHour + 1) * HOUR_MS },
      mergeLatencyHistograms(histograms)
    ),
    buckets,
  }
}

export function buildSnapshot(inputs: SnapshotInputs): PublicStatusSnapshot {
  const components: ComponentSnapshot[] = COMPONENT_IDS.map((componentId) => {
    const evaluated = inputs.evaluated.find((item) => item.evaluation.componentId === componentId)
    const { buckets, total } = historyFor(
      inputs,
      (rollup) => rollup?.c[componentId],
      inputs.exclusions.perComponent[componentId] ?? []
    )
    return {
      id: componentId,
      status: evaluated?.evaluation.status ?? "unknown",
      confidence: evaluated?.evaluation.confidence ?? "none",
      latestEvidenceAt:
        evaluated?.evaluation.latestEvidenceAtMs == null
          ? null
          : toIso(evaluated.evaluation.latestEvidenceAtMs),
      inMaintenance: evaluated?.evaluation.inMaintenance ?? false,
      availability: summarizeAvailability(total),
      history: buckets,
      latency: latencyFor(inputs, componentId),
      evidence: evaluated?.evidence ?? [],
    }
  })
  const overall = historyFor(inputs, (rollup) => rollup?.o, inputs.exclusions.overall)
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    mode: "live",
    revision: inputs.revision,
    generatedAt: toIso(inputs.nowMs),
    serverTime: toIso(inputs.nowMs),
    observationStartedAt:
      inputs.observationStartMinute === null
        ? null
        : toIso(inputs.observationStartMinute * MINUTE_MS),
    range: inputs.range,
    staleAfterMs: SNAPSHOT_STALE_MS,
    freshness: { referenceFreshMs: REFERENCE_FRESH_MS, profileFreshMs: PROFILE_FRESH_MS },
    overallStatus: deriveOverallStatus(components.map((component) => component.status)),
    monitoringStatus: deriveMonitoringStatus(inputs.probes),
    overall: { availability: summarizeAvailability(overall.total), history: overall.buckets },
    components,
    probes: inputs.probes,
    activeIncidents: inputs.incidents.active.slice(0, 50),
    pastIncidents: inputs.incidents.past.slice(0, 50),
    scheduledMaintenance: inputs.maintenance.slice(0, 50),
    capabilities: inputs.capabilities,
  }
}

export function snapshotEtag(revision: number, range: HistoryRange): string {
  return `"r${revision}-${range}"`
}

/**
 * Build and store every range under the aggregation lease. A runner that
 * lost its lease writes nothing (each row is fence-guarded).
 */
export async function publishSnapshots(
  job: JobContext,
  base: Omit<SnapshotInputs, "range" | "revision">
): Promise<number> {
  const db = job.env.DB
  const revision = await nextCounter(db, "snapshot_revision")
  const statements: D1PreparedStatement[] = []
  for (const range of HISTORY_RANGES) {
    const snapshot = buildSnapshot({ ...base, range, revision })
    const body = JSON.stringify(snapshot)
    if (body.length > MAX_SNAPSHOT_BYTES) {
      // Never truncate evidence silently: refuse to publish this range and
      // leave the previous row, whose age the page shows as stale.
      logEvent("snapshot.too_large", { range, bytes: body.length, revision })
      continue
    }
    const guard = leaseGuard(job.lease, job.nowMs)
    statements.push(
      db
        .prepare(
          `INSERT INTO snapshots (range, revision, generated_at, etag, body)
           SELECT ?, ?, ?, ?, ? WHERE ${guard.sql}
           ON CONFLICT (range) DO UPDATE SET revision = excluded.revision,
             generated_at = excluded.generated_at, etag = excluded.etag, body = excluded.body
           WHERE excluded.revision > snapshots.revision`
        )
        .bind(range, revision, base.nowMs, snapshotEtag(revision, range), body, ...guard.params)
    )
  }
  if (statements.length > 0) await db.batch(statements)
  return revision
}
