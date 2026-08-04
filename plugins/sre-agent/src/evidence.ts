export type SreEvidenceSource = "logs" | "trace" | "metrics" | "runbook"

export type SreTimelineSource = SreEvidenceSource | "file"

export type SreTimelineFlag = "error" | "timeout" | "retry" | "fallback" | "slow" | "infra"

export interface SreTimeRange {
  startTime: string
  endTime: string
}

export interface SreBaseEvidence {
  id: string
  source: SreEvidenceSource
  time?: string
  service?: string
  component?: string
  raw: string | Record<string, unknown>
  parsed?: Record<string, unknown>
}

export interface SreLogEvidence extends SreBaseEvidence {
  source: "logs"
  sourceKind: "json" | "text"
  level?: "debug" | "info" | "warn" | "error"
  eventName?: string
  traceId?: string
  requestId?: string
}

export interface SreTraceSpanEvidence extends SreBaseEvidence {
  source: "trace"
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  startTime: string
  endTime?: string
  durationMs?: number
  status: "ok" | "error"
  attributes: Record<string, unknown>
}

export interface SreMetricEvidence extends SreBaseEvidence {
  source: "metrics"
  job: string
  metric: string
  timeRange: [string, string]
  labels: Record<string, string>
  value: number
  unit?: string
  valueKind: "gauge" | "counter_delta" | "histogram_quantile"
  interpretation?: string
}

export interface SreRunbookEvidence extends SreBaseEvidence {
  source: "runbook"
  title: string
}

export type SreEvidence =
  SreLogEvidence | SreTraceSpanEvidence | SreMetricEvidence | SreRunbookEvidence

export interface SreTimelineRow {
  time: string
  component: string
  event: string
  signals: string[]
  evidenceIds: string[]
  sources: SreTimelineSource[]
  confidence: number
  flags: SreTimelineFlag[]
  notes?: string
}

export interface SreFinding {
  text: string
  evidenceIds: string[]
}

export interface SreTimelineDraft {
  rows: SreTimelineRow[]
  findings?: SreFinding[]
  recommendations?: SreFinding[]
}

export interface SreValidationIssue {
  code: string
  message: string
  rowIndex?: number
  evidenceId?: string
}

export interface SreValidationResult {
  ok: boolean
  issues: SreValidationIssue[]
  evidenceCount: number
}

const SENSITIVE_KEY_RE = /\b(api[_-]?key|token|secret|authorization|password)\b/i
const API_KEY_VALUE_RE = /\bak_[A-Za-z0-9_-]+\b/g

export function redactSensitiveText(text: string): string {
  return text.replace(API_KEY_VALUE_RE, "ak_[redacted]")
}

export function redactSensitiveValue(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value)
  if (Array.isArray(value)) return value.map((entry) => redactSensitiveValue(entry))
  if (!value || typeof value !== "object") return value
  const out: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY_RE.test(key) ? "[redacted]" : redactSensitiveValue(nested)
  }
  return out
}

export function evidenceText(evidence: SreEvidence): string {
  return JSON.stringify(redactSensitiveValue(evidence))
}

export function containsSensitiveText(text: string): boolean {
  return SENSITIVE_KEY_RE.test(text) || API_KEY_VALUE_RE.test(text)
}
