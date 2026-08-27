/**
 * The bundled-fixture provider — the first implementation of `SreLogProvider`,
 * and the one the plugin defaults to.
 *
 * Everything here used to live inline in `runtime.ts`, which is why the filter
 * predicates read the way they do: they are the same ones the four agent tools
 * have been answering with since the plugin shipped, moved behind the seam
 * rather than rewritten. Behaviour is deliberately unchanged — the fixture is
 * also the golden-timeline test corpus.
 */

import {
  FIXTURE_END,
  FIXTURE_REQUEST_ID,
  FIXTURE_SOURCE_TEXT,
  FIXTURE_START,
  FIXTURE_TRACE_ID,
  LOG_EVIDENCE,
  METRIC_EVIDENCE,
  RUNBOOK_EVIDENCE,
  TRACE_EVIDENCE,
} from "../fixtures"
import {
  evidenceText,
  type SreEvidence,
  type SreLogEvidence,
  type SreMetricEvidence,
  type SreTimeRange,
} from "../evidence"
import { logTemplate, templateId } from "./log-template"
import type {
  SreFacet,
  SreHistogramBucket,
  SreIngestSource,
  SreLogFilter,
  SreLogLevel,
  SreLogPattern,
  SreLogProvider,
  SreMetricFilter,
  SreTraceFilter,
} from "./types"

const LOG_LEVELS: readonly SreLogLevel[] = ["debug", "info", "warn", "error"]

/** Upper bound on histogram resolution — one bucket per bar the panel can draw. */
const MAX_BUCKETS = 240

function inRange(time: string | undefined, startTime: string, endTime: string): boolean {
  if (!time) return true
  const ts = Date.parse(time)
  return ts >= Date.parse(startTime) && ts <= Date.parse(endTime)
}

function rangesOverlap(
  leftStart: string,
  leftEnd: string,
  rightStart: string,
  rightEnd: string
): boolean {
  return (
    Date.parse(leftStart) <= Date.parse(rightEnd) && Date.parse(leftEnd) >= Date.parse(rightStart)
  )
}

function normalizedTraceId(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase()
}

/**
 * Keyword matching runs over the REDACTED serialization on purpose: matching
 * the raw record would turn `keywords` into an oracle for the very values
 * `redactSensitiveValue` exists to withhold.
 */
function textIncludesAll(record: SreLogEvidence, keywords: string[] | undefined): boolean {
  if (!keywords || keywords.length === 0) return true
  const lower = evidenceText(record).toLowerCase()
  return keywords.every((keyword) => lower.includes(keyword.toLowerCase()))
}

function labelsMatch(
  labels: Record<string, string>,
  wanted: Record<string, string> | undefined
): boolean {
  if (!wanted) return true
  return Object.entries(wanted).every(([key, value]) => labels[key] === value)
}

/** Apply one log filter to the bundled corpus. Exported for the provider's own tests. */
export function filterFixtureLogs(filter: SreLogFilter): SreLogEvidence[] {
  const services = new Set(filter.services ?? [])
  const levels = new Set(filter.levels ?? [])
  const ids = filter.ids ? new Set(filter.ids) : null
  const traceId = normalizedTraceId(filter.traceId)
  const requestId = filter.requestId?.trim()
  return LOG_EVIDENCE.filter((record) => {
    if (ids && !ids.has(record.id)) return false
    if (!inRange(record.time, filter.startTime, filter.endTime)) return false
    if (services.size > 0 && !services.has(record.service ?? "")) return false
    if (levels.size > 0 && !(record.level && levels.has(record.level))) return false
    if (traceId && normalizedTraceId(record.traceId) !== traceId) return false
    if (requestId && record.requestId !== requestId) return false
    return textIncludesAll(record, filter.keywords)
  })
}

/**
 * Read one facet field off a record.
 *
 * Structured logs keep the interesting dimensions (`provider`, `model`,
 * `error_class`) inside `raw`, so a facet that only looked at the typed surface
 * would offer `service` and `level` and nothing worth slicing by.
 */
export function facetValueOf(record: SreLogEvidence, field: string): string | undefined {
  switch (field) {
    case "service":
      return record.service
    case "level":
      return record.level
    case "event":
      return record.eventName
    case "component":
      return record.component
    default:
      break
  }
  for (const source of [record.raw, record.parsed]) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue
    const value = (source as Record<string, unknown>)[field]
    if (typeof value === "string" || typeof value === "number") return String(value)
  }
  return undefined
}

function emptyLevelCounts(): Record<SreLogLevel, number> {
  return { debug: 0, info: 0, warn: 0, error: 0 }
}

/** Bucket records evenly across the filter's window. Exported for tests. */
export function bucketLogs(
  records: SreLogEvidence[],
  window: SreTimeRange,
  bucketCount: number
): SreHistogramBucket[] {
  const count = Math.max(1, Math.min(Math.floor(bucketCount) || 1, MAX_BUCKETS))
  const start = Date.parse(window.startTime)
  const end = Date.parse(window.endTime)
  const span = Math.max(1, end - start)
  const buckets: SreHistogramBucket[] = Array.from({ length: count }, (_unused, index) => ({
    startTime: new Date(start + (span * index) / count).toISOString(),
    endTime: new Date(start + (span * (index + 1)) / count).toISOString(),
    total: 0,
    byLevel: emptyLevelCounts(),
  }))
  for (const record of records) {
    if (!record.time) continue
    const offset = Date.parse(record.time) - start
    if (!Number.isFinite(offset)) continue
    const index = Math.min(count - 1, Math.max(0, Math.floor((offset / span) * count)))
    const bucket = buckets[index]
    bucket.total += 1
    // A record with no level still counts toward `total`: the bar height is
    // "how much happened", and dropping unlevelled lines would under-draw it.
    if (record.level) bucket.byLevel[record.level] += 1
  }
  return buckets
}

/** Group records into masked templates, newest-first by count. Exported for tests. */
export function groupPatterns(
  records: SreLogEvidence[],
  baselineRecords: SreLogEvidence[] | null
): SreLogPattern[] {
  const baseline = new Map<string, number>()
  if (baselineRecords) {
    for (const record of baselineRecords) {
      const template = logTemplate(record)
      baseline.set(template, (baseline.get(template) ?? 0) + 1)
    }
  }

  const groups = new Map<string, SreLogPattern>()
  for (const record of records) {
    const template = logTemplate(record)
    const existing = groups.get(template)
    const time = record.time ?? ""
    if (existing) {
      existing.count += 1
      existing.evidenceIds.push(record.id)
      if (record.service && !existing.services.includes(record.service)) {
        existing.services.push(record.service)
      }
      if (record.level && !existing.levels.includes(record.level))
        existing.levels.push(record.level)
      if (time && (!existing.firstSeen || time < existing.firstSeen)) existing.firstSeen = time
      if (time && time > existing.lastSeen) existing.lastSeen = time
      continue
    }
    groups.set(template, {
      id: templateId(template),
      template,
      count: 1,
      baselineCount: baselineRecords ? (baseline.get(template) ?? 0) : null,
      changeRatio: null,
      services: record.service ? [record.service] : [],
      levels: record.level ? [record.level] : [],
      firstSeen: time,
      lastSeen: time,
      evidenceIds: [record.id],
    })
  }

  return [...groups.values()]
    .map((pattern) => ({
      ...pattern,
      services: [...pattern.services].sort(),
      levels: LOG_LEVELS.filter((level) => pattern.levels.includes(level)),
      changeRatio:
        pattern.baselineCount === null || pattern.baselineCount === 0
          ? null
          : (pattern.count - pattern.baselineCount) / pattern.baselineCount,
    }))
    .sort((left, right) => right.count - left.count || left.template.localeCompare(right.template))
}

/** Create the read-only provider backed by the checked-in incident fixture. */
export function createFixtureProvider(): SreLogProvider {
  return {
    id: "qwen-timeout-fallback",
    kind: "fixture",
    coverage: () => ({ startTime: FIXTURE_START, endTime: FIXTURE_END }),

    fetchLogs: async (filter) => filterFixtureLogs(filter),

    fetchTrace: async (filter: SreTraceFilter) => {
      const traceId = normalizedTraceId(filter.traceId)
      const requestId = filter.requestId?.trim()
      const matches =
        traceId === normalizedTraceId(FIXTURE_TRACE_ID) || requestId === FIXTURE_REQUEST_ID
      if (!matches) return []
      if (filter.startTime === undefined || filter.endTime === undefined) return TRACE_EVIDENCE
      const { startTime, endTime } = filter
      return TRACE_EVIDENCE.filter((record) =>
        rangesOverlap(record.startTime, record.endTime ?? record.startTime, startTime, endTime)
      )
    },

    fetchMetrics: async (filter: SreMetricFilter) => {
      const jobs = new Set(filter.jobs ?? [])
      const metrics = new Set(filter.metrics ?? [])
      return METRIC_EVIDENCE.filter((record: SreMetricEvidence) => {
        if (
          !rangesOverlap(record.timeRange[0], record.timeRange[1], filter.startTime, filter.endTime)
        ) {
          return false
        }
        if (jobs.size > 0 && !jobs.has(record.job)) return false
        if (metrics.size > 0 && !metrics.has(record.metric)) return false
        return labelsMatch(record.labels, filter.labels)
      })
    },

    ambientEvidence: (): SreEvidence[] => [...RUNBOOK_EVIDENCE],

    histogram: async (filter, bucketCount) =>
      bucketLogs(filterFixtureLogs(filter), filter, bucketCount),

    patterns: async (filter, baseline) => {
      const baselineRecords = baseline ? filterFixtureLogs({ ...filter, ...baseline }) : null
      return groupPatterns(filterFixtureLogs(filter), baselineRecords)
    },

    facets: async (filter, fields, limit) => {
      const records = filterFixtureLogs(filter)
      const cap = Math.max(1, Math.floor(limit) || 1)
      return fields.map<SreFacet>((field) => {
        const counts = new Map<string, number>()
        let total = 0
        for (const record of records) {
          const value = facetValueOf(record, field)
          if (value === undefined) continue
          total += 1
          counts.set(value, (counts.get(value) ?? 0) + 1)
        }
        return {
          field,
          total,
          values: [...counts.entries()]
            .map(([value, count]) => ({ value, count }))
            .sort(
              (left, right) => right.count - left.count || left.value.localeCompare(right.value)
            )
            .slice(0, cap),
        }
      })
    },

    /**
     * The four outlets the fixture actually bundles, reported as `static`.
     *
     * A lag number here would be invented — these are files in the bundle, not
     * a pipeline — so every live-only field is `null` and the panel says
     * "bundled fixture" instead of drawing a healthy collector that does not
     * exist. This is the shape a real provider fills in with collector state.
     */
    sources: async (): Promise<SreIngestSource[]> => [
      {
        id: "gateway-logs",
        label: "gateway",
        pipeline: "bundled fixture (JSONL)",
        status: "static",
        lagMs: null,
        recordCount: FIXTURE_SOURCE_TEXT.gatewayLogs.split("\n").filter(Boolean).length,
        bytes24h: null,
      },
      {
        id: "maas-logs",
        label: "maas",
        pipeline: "bundled fixture (JSONL)",
        status: "static",
        lagMs: null,
        recordCount: FIXTURE_SOURCE_TEXT.maasLogs.split("\n").filter(Boolean).length,
        bytes24h: null,
      },
      {
        id: "vllm-logs",
        label: "vllm-server",
        pipeline: "bundled fixture (stdout)",
        status: "static",
        lagMs: null,
        recordCount: FIXTURE_SOURCE_TEXT.vllmLogs.split("\n").filter(Boolean).length,
        bytes24h: null,
      },
      {
        id: "prometheus",
        label: "prometheus",
        pipeline: "bundled fixture (exposition)",
        status: "static",
        lagMs: null,
        recordCount: METRIC_EVIDENCE.length,
        bytes24h: null,
      },
    ],
  }
}
