import type { FullPluginContext } from "@cognia/plugin-sdk/context"
import {
  FIXTURE_END,
  FIXTURE_REQUEST_ID,
  FIXTURE_START,
  FIXTURE_TRACE_ID,
  LOG_EVIDENCE,
  METRIC_EVIDENCE,
  RUNBOOK_EVIDENCE,
  TRACE_EVIDENCE,
} from "./fixtures"
import {
  evidenceText,
  type SreEvidence,
  type SreLogEvidence,
  type SreMetricEvidence,
  type SreTimelineDraft,
  type SreTraceSpanEvidence,
  type SreValidationResult,
} from "./evidence"
import { validateTimelineDraft } from "./validator"

export interface SrePluginContext {
  pluginId: string
  logger?: FullPluginContext["logger"]
}

export interface SreQueryLogsInput {
  environment: string
  startTime: string
  endTime: string
  services?: string[]
  traceId?: string
  requestId?: string
  keywords?: string[]
}

export interface SreQueryTraceInput {
  environment: string
  traceId?: string
  requestId?: string
  startTime?: string
  endTime?: string
}

export interface SreQueryMetricsInput {
  environment: string
  startTime: string
  endTime: string
  jobs?: string[]
  metrics?: string[]
  labels?: Record<string, string>
}

export interface SreQueryResult<T extends SreEvidence> {
  ok: true
  records: T[]
  evidenceIds: string[]
  fixture: string
}

export interface SreRuntime {
  queryLogs(input: SreQueryLogsInput): Promise<SreQueryResult<SreLogEvidence>>
  queryTrace(input: SreQueryTraceInput): Promise<SreQueryResult<SreTraceSpanEvidence>>
  queryMetrics(input: SreQueryMetricsInput): Promise<SreQueryResult<SreMetricEvidence>>
  validateTimeline(input: SreTimelineDraft): Promise<SreValidationResult>
  evidenceSnapshot(): SreEvidence[]
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value.trim()
}

function assertRange(startTime: string, endTime: string): void {
  const start = Date.parse(startTime)
  const end = Date.parse(endTime)
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error("startTime and endTime must be valid ISO timestamps")
  }
  if (start > end) throw new Error("startTime must be before endTime")
}

function inRange(time: string | undefined, startTime: string, endTime: string): boolean {
  if (!time) return true
  const ts = Date.parse(time)
  return ts >= Date.parse(startTime) && ts <= Date.parse(endTime)
}

function normalizedTraceId(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase()
}

function textIncludesAll(haystack: string, keywords: string[] | undefined): boolean {
  if (!keywords || keywords.length === 0) return true
  const lower = haystack.toLowerCase()
  return keywords.every((keyword) => lower.includes(keyword.toLowerCase()))
}

function labelsMatch(
  labels: Record<string, string>,
  wanted: Record<string, string> | undefined
): boolean {
  if (!wanted) return true
  return Object.entries(wanted).every(([key, value]) => labels[key] === value)
}

export function defaultIncidentWindow(): { startTime: string; endTime: string } {
  return { startTime: FIXTURE_START, endTime: FIXTURE_END }
}

export function createSreRuntime(_ctx: SrePluginContext): SreRuntime {
  const evidencePool = new Map<string, SreEvidence>()
  const remember = <T extends SreEvidence>(records: T[]): SreQueryResult<T> => {
    for (const record of records) evidencePool.set(record.id, record)
    return {
      ok: true,
      records,
      evidenceIds: records.map((record) => record.id),
      fixture: "qwen-timeout-fallback",
    }
  }

  return {
    queryLogs: async (input) => {
      requireNonEmpty(input.environment, "environment")
      requireNonEmpty(input.startTime, "startTime")
      requireNonEmpty(input.endTime, "endTime")
      assertRange(input.startTime, input.endTime)
      const services = new Set(input.services ?? [])
      const traceId = normalizedTraceId(input.traceId)
      const requestId = input.requestId?.trim()
      const records = LOG_EVIDENCE.filter((record) => {
        if (!inRange(record.time, input.startTime, input.endTime)) return false
        if (services.size > 0 && !services.has(record.service ?? "")) return false
        if (traceId && normalizedTraceId(record.traceId) !== traceId) return false
        if (requestId && record.requestId !== requestId) return false
        return textIncludesAll(evidenceText(record), input.keywords)
      })
      return remember(records)
    },
    queryTrace: async (input) => {
      requireNonEmpty(input.environment, "environment")
      const traceId = normalizedTraceId(input.traceId)
      const requestId = input.requestId?.trim()
      if (!traceId && !requestId) throw new Error("traceId or requestId is required")
      const records =
        traceId === normalizedTraceId(FIXTURE_TRACE_ID) || requestId === FIXTURE_REQUEST_ID
          ? TRACE_EVIDENCE
          : []
      return remember(records)
    },
    queryMetrics: async (input) => {
      requireNonEmpty(input.environment, "environment")
      requireNonEmpty(input.startTime, "startTime")
      requireNonEmpty(input.endTime, "endTime")
      assertRange(input.startTime, input.endTime)
      const jobs = new Set(input.jobs ?? [])
      const metrics = new Set(input.metrics ?? [])
      const records = METRIC_EVIDENCE.filter((record) => {
        if (jobs.size > 0 && !jobs.has(record.job)) return false
        if (metrics.size > 0 && !metrics.has(record.metric)) return false
        if (!labelsMatch(record.labels, input.labels)) return false
        return true
      })
      return remember(records)
    },
    validateTimeline: async (input) => validateTimelineDraft(input, evidencePool.values()),
    evidenceSnapshot: () => [...evidencePool.values(), ...RUNBOOK_EVIDENCE],
  }
}
