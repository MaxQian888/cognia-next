/**
 * Contract v1 fixtures for tests, stories and explicit development previews.
 *
 * Never a production fallback: the live page shows "unknown" when it has no
 * validated snapshot, and nothing outside tests/stories imports this module.
 * Fixtures are built with the real derivation functions, so a fixture can
 * only show what the Worker could actually publish.
 */

import {
  COMPONENT_IDS,
  COMPONENT_LATENCY_PHASE,
  HISTORY_RANGES,
  LATENCY_MIN_SAMPLES,
  PROFILE_FRESH_MS,
  REFERENCE_FRESH_MS,
  SNAPSHOT_STALE_MS,
  STATUS_LOCALES,
  STATUS_SCHEMA_VERSION,
  type ComponentId,
  type ComponentSnapshot,
  type DisplayStatus,
  type HistoryBucket,
  type HistoryRange,
  type IncidentSummary,
  type MaintenanceView,
  type ProbeSummary,
  type PublicStatusSnapshot,
} from "./contract"
import {
  bucketStatus,
  deriveMonitoringStatus,
  deriveOverallStatus,
  enumerateRangeBuckets,
  expectedMinutesInBucket,
  latencyBucketView,
  minuteOf,
  summarizeAvailability,
  toIso,
  type RawSlotCounts,
} from "./derive"

export const FIXTURE_NOW_MS = Date.parse("2026-10-02T10:00:00.000Z")
/** Observation began 40 days before the fixture clock. */
export const FIXTURE_OBSERVATION_START_MS = FIXTURE_NOW_MS - 40 * 86_400_000

export type StatusFixtureVariant =
  "operational" | "degraded" | "major_outage" | "maintenance" | "unknown" | "empty"

const REFERENCE_PROBE: ProbeSummary = {
  id: "cf-cron",
  label: { en: "Cloudflare scheduled check", "zh-CN": "Cloudflare 定时检查" },
  source: "cloudflare",
  location: null,
  provider: "Cloudflare Workers",
  profiles: [{ id: "native", cadenceSeconds: 60, simulatedOrigin: false }],
  reference: true,
  enrolledAt: toIso(FIXTURE_OBSERVATION_START_MS),
  lastAttemptAt: toIso(FIXTURE_NOW_MS - 30_000),
  lastSuccessAt: toIso(FIXTURE_NOW_MS - 30_000),
  health: "healthy",
  reason: null,
}

const INCIDENT: IncidentSummary = {
  id: "inc_fixture_auth",
  title: { en: "Authenticated signaling failures", "zh-CN": "认证信令失败" },
  state: "investigating",
  impact: "major_outage",
  componentIds: ["signalingAuth", "relayData"],
  source: "automated",
  startedAt: toIso(FIXTURE_NOW_MS - 6 * 60_000),
  resolvedAt: null,
  updatedAt: toIso(FIXTURE_NOW_MS - 6 * 60_000),
  revision: 1,
  predecessorId: null,
  latestUpdate: {
    id: "upd_fixture_1",
    state: "investigating",
    impact: "major_outage",
    componentIds: ["signalingAuth", "relayData"],
    message: {
      en: "Three consecutive reference checks failed to authenticate into a test room.",
      "zh-CN": "参考探针连续三次未能在测试房间完成认证。",
    },
    source: "automated",
    at: toIso(FIXTURE_NOW_MS - 6 * 60_000),
    correctionOf: null,
  },
}

const PAST_INCIDENT: IncidentSummary = {
  ...INCIDENT,
  id: "inc_fixture_past",
  title: { en: "Relay data lane interruption", "zh-CN": "数据通道中断" },
  state: "resolved",
  impact: "partial_outage",
  componentIds: ["relayData"],
  startedAt: toIso(FIXTURE_NOW_MS - 9 * 86_400_000),
  resolvedAt: toIso(FIXTURE_NOW_MS - 9 * 86_400_000 + 47 * 60_000),
  updatedAt: toIso(FIXTURE_NOW_MS - 9 * 86_400_000 + 47 * 60_000),
  revision: 3,
  latestUpdate: null,
}

const MAINTENANCE: MaintenanceView = {
  id: "mnt_fixture",
  title: { en: "Relay runtime upgrade", "zh-CN": "中继运行时升级" },
  description: {
    en: "Signaling sessions may reconnect once during the window.",
    "zh-CN": "维护期间信令会话可能重连一次。",
  },
  componentIds: ["signalingAuth", "relayData"],
  state: "scheduled",
  startsAt: toIso(FIXTURE_NOW_MS + 2 * 86_400_000),
  endsAt: toIso(FIXTURE_NOW_MS + 2 * 86_400_000 + 3_600_000),
  actualEndAt: null,
  excludeFromAvailability: true,
  revision: 1,
  updates: [],
}

function countsFor(expected: number, failMinutes: number, unknownMinutes: number): RawSlotCounts {
  const failCount = Math.min(expected, failMinutes)
  const unknown = Math.min(expected - failCount, unknownMinutes)
  return {
    passCount: expected - failCount - unknown,
    failCount,
    expectedSlots: expected,
    excludedSlots: 0,
    excludedPassCount: 0,
    excludedFailCount: 0,
  }
}

function history(
  range: HistoryRange,
  observationStart: number | null,
  failuresByBucketFromEnd: Record<number, number>
): { buckets: HistoryBucket[]; total: RawSlotCounts } {
  const buckets = enumerateRangeBuckets(range, FIXTURE_NOW_MS)
  const startMinute = observationStart === null ? null : minuteOf(observationStart)
  const total: RawSlotCounts = countsFor(0, 0, 0)
  const views = buckets.map((bucket, index) => {
    const fromEnd = buckets.length - 1 - index
    const { count } = expectedMinutesInBucket(bucket, startMinute, FIXTURE_NOW_MS)
    const counts = countsFor(count, failuresByBucketFromEnd[fromEnd] ?? 0, count > 0 ? 1 : 0)
    total.passCount += counts.passCount
    total.failCount += counts.failCount
    total.expectedSlots += counts.expectedSlots
    const availability = summarizeAvailability(counts)
    return {
      start: toIso(bucket.startMs),
      end: toIso(bucket.endMs),
      partial: fromEnd === 0 || (startMinute !== null && bucket.startMs < observationStart!),
      status: bucketStatus(availability),
      availability,
    }
  })
  return { buckets: views, total }
}

function component(
  id: ComponentId,
  status: DisplayStatus,
  range: HistoryRange,
  observationStart: number | null,
  failures: Record<number, number>
): ComponentSnapshot {
  const { buckets, total } = history(range, observationStart, failures)
  const latencyBuckets = enumerateRangeBuckets("24h", FIXTURE_NOW_MS).map((bucket, index) =>
    latencyBucketView(
      bucket,
      observationStart === null
        ? []
        : // 60 samples an hour, mostly fast, with a slow tail.
          [0, 10, 30, 12, 5, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, index % 4 === 0 ? 1 : 0]
    )
  )
  const summary = latencyBucketView(
    { startMs: FIXTURE_NOW_MS - 86_400_000, endMs: FIXTURE_NOW_MS },
    observationStart === null ? [] : [0, 240, 720, 288, 120, 48, 24]
  )
  return {
    id,
    status,
    confidence: status === "unknown" ? "none" : "single_witness",
    latestEvidenceAt:
      status === "unknown" || observationStart === null ? null : toIso(FIXTURE_NOW_MS - 30_000),
    inMaintenance: status === "maintenance",
    availability: summarizeAvailability(total),
    history: buckets,
    latency: {
      phase: COMPONENT_LATENCY_PHASE[id],
      minSamples: LATENCY_MIN_SAMPLES,
      summary,
      buckets: latencyBuckets,
    },
    evidence:
      observationStart === null
        ? []
        : [
            {
              probeId: REFERENCE_PROBE.id,
              profileId: "native",
              source: "cloudflare",
              reference: true,
              result: status === "unknown" ? "unknown" : status === "operational" ? "pass" : "fail",
              reason:
                status === "unknown"
                  ? "stale"
                  : status === "operational" || status === "maintenance"
                    ? null
                    : "auth_timeout",
              checkedAt:
                status === "unknown"
                  ? toIso(FIXTURE_NOW_MS - 20 * 60_000)
                  : toIso(FIXTURE_NOW_MS - 30_000),
              fresh: status !== "unknown",
              consecutiveFailures: status === "major_outage" ? 6 : status === "degraded" ? 1 : 0,
              simulatedOrigin: false,
            },
          ],
  }
}

/**
 * A complete, schema-valid snapshot for one scenario. `degraded` and
 * `major_outage` fail the auth and data components; `maintenance` puts them
 * under an active window; `unknown` has a stale reference; `empty` has no
 * probe enrolled yet.
 */
export function createStatusFixture(
  variant: StatusFixtureVariant = "operational",
  range: HistoryRange = "90d"
): PublicStatusSnapshot {
  const observationStart = variant === "empty" ? null : FIXTURE_OBSERVATION_START_MS
  const failing: DisplayStatus =
    variant === "degraded"
      ? "degraded"
      : variant === "major_outage"
        ? "major_outage"
        : variant === "maintenance"
          ? "maintenance"
          : variant === "unknown" || variant === "empty"
            ? "unknown"
            : "operational"
  const components = COMPONENT_IDS.map((id) => {
    const status: DisplayStatus =
      variant === "empty" || variant === "unknown"
        ? "unknown"
        : id === "signalingHttp"
          ? "operational"
          : failing
    const failures: Record<number, number> =
      id === "signalingHttp" ? { 12: 4 } : variant === "major_outage" ? { 0: 6, 9: 47 } : { 9: 47 }
    return component(id, status, range, observationStart, failures)
  })
  const overallHistory = history(range, observationStart, {
    0: variant === "major_outage" ? 6 : 0,
    9: 47,
    12: 4,
  })
  const probes: ProbeSummary[] =
    variant === "empty"
      ? []
      : [
          variant === "unknown"
            ? {
                ...REFERENCE_PROBE,
                lastAttemptAt: toIso(FIXTURE_NOW_MS - 20 * 60_000),
                lastSuccessAt: toIso(FIXTURE_NOW_MS - 20 * 60_000),
                health: "stale",
                reason: "stale",
              }
            : REFERENCE_PROBE,
        ]
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    mode: "live",
    revision: 4_812,
    generatedAt: toIso(FIXTURE_NOW_MS - 20_000),
    serverTime: toIso(FIXTURE_NOW_MS),
    observationStartedAt: observationStart === null ? null : toIso(observationStart),
    range,
    staleAfterMs: SNAPSHOT_STALE_MS,
    freshness: { referenceFreshMs: REFERENCE_FRESH_MS, profileFreshMs: PROFILE_FRESH_MS },
    overallStatus: deriveOverallStatus(components.map((item) => item.status)),
    monitoringStatus: deriveMonitoringStatus(probes),
    overall: {
      availability: summarizeAvailability(overallHistory.total),
      history: overallHistory.buckets,
    },
    components,
    probes,
    activeIncidents: variant === "major_outage" ? [INCIDENT] : [],
    pastIncidents: variant === "empty" ? [] : [PAST_INCIDENT],
    scheduledMaintenance:
      variant === "maintenance"
        ? [
            {
              ...MAINTENANCE,
              state: "in_progress",
              startsAt: toIso(FIXTURE_NOW_MS - 30 * 60_000),
              endsAt: toIso(FIXTURE_NOW_MS + 30 * 60_000),
            },
          ]
        : variant === "empty"
          ? []
          : [MAINTENANCE],
    capabilities: {
      email: true,
      feeds: true,
      locales: [...STATUS_LOCALES],
      historyRanges: [...HISTORY_RANGES],
      mirrorUrl: null,
      primaryUrl: "https://status.cognia.cn/status/",
    },
  }
}

export const FIXTURE_ACTIVE_INCIDENT = INCIDENT
export const FIXTURE_PAST_INCIDENT = PAST_INCIDENT
export const FIXTURE_MAINTENANCE = MAINTENANCE
