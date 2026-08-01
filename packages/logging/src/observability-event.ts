import schema from "./schemas/observability-event-v1.schema.json"
import type { LogLevel, LogOrigin, LogRuntime, StructuredLogEntry } from "./types"

export type ObservabilityEventKind = "log" | "span" | "crash" | "lifecycle" | "metric"

export type ObservabilityRuntime =
  LogRuntime | "sidecar" | "cli" | "companion" | "capacitor-ios" | "capacitor-android"

export interface ObservabilityEventScope {
  tenantId: string
  installationId: string
  runtime: ObservabilityRuntime
  processId: string
  module: string
  pluginId?: string
  buildId: string
  appVersion: string
  origin?: LogOrigin | string
}

export interface ObservabilityCorrelation {
  traceparent?: string
  tracestate?: string
  traceId?: string
  spanId?: string
  parentSpanId?: string
  sessionId?: string
  requestId?: string
  executionId?: string
  workflowId?: string
  stepId?: string
}

export interface ObservabilityPrivacy {
  redactionVersion: string
  capturePolicy: "metadata-only" | "debug-session"
  contentCaptured: boolean
  removedFields: string[]
}

export interface ObservabilityDelivery {
  spoolSequence: number
  flushWatermark: number
}

export interface ObservabilityPayload extends Record<string, unknown> {
  message: string
  data?: Record<string, unknown>
  stack?: string
  tags?: string[]
  phase?: string
  attempt?: number
  durationMs?: number
  source?: StructuredLogEntry["source"]
  legacyEventId?: string
}

export interface ObservabilityEventV1 {
  schemaVersion: 1
  eventId: string
  occurredAt: string
  kind: ObservabilityEventKind
  severity: LogLevel
  name: string
  code: string
  scope: ObservabilityEventScope
  correlation: ObservabilityCorrelation
  privacy: ObservabilityPrivacy
  delivery: ObservabilityDelivery
  payload: ObservabilityPayload
}

export interface StructuredLogAdapterContext {
  scope: ObservabilityEventScope
  redactionVersion: string
  capturePolicy?: ObservabilityPrivacy["capturePolicy"]
  contentCaptured?: boolean
  removedFields?: string[]
  spoolSequence: number
  flushWatermark: number
  traceparent?: string
  tracestate?: string
}

export const OBSERVABILITY_EVENT_V1_SCHEMA = schema

const W3C_TRACE_ID = /^[0-9a-f]{32}$/
const W3C_SPAN_ID = /^[0-9a-f]{16}$/

function createTraceparent(traceId?: string, spanId?: string): string | undefined {
  if (!traceId || !spanId || !W3C_TRACE_ID.test(traceId) || !W3C_SPAN_ID.test(spanId)) {
    return undefined
  }

  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) {
    return undefined
  }

  return `00-${traceId}-${spanId}-01`
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, nested]) => nested !== undefined)) as T
}

function stableLegacyCode(entry: StructuredLogEntry): string {
  if (entry.code?.trim()) {
    return entry.code.trim()
  }

  const moduleCode = entry.module
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
  return moduleCode ? `log.${moduleCode}` : "log.legacy"
}

export function structuredLogEntryToObservabilityEvent(
  entry: StructuredLogEntry,
  context: StructuredLogAdapterContext
): ObservabilityEventV1 {
  const traceparent = context.traceparent ?? createTraceparent(entry.traceId, entry.spanId)

  return {
    schemaVersion: 1,
    eventId: entry.id,
    occurredAt: entry.timestamp,
    kind: "log",
    severity: entry.level,
    name: entry.message || stableLegacyCode(entry),
    code: stableLegacyCode(entry),
    scope: compact({
      ...context.scope,
      module: entry.module || context.scope.module,
      runtime: entry.runtime ?? context.scope.runtime,
      origin: entry.origin ?? context.scope.origin,
    }),
    correlation: compact({
      traceparent,
      tracestate: context.tracestate,
      traceId: entry.traceId,
      spanId: entry.spanId,
      parentSpanId: entry.parentSpanId,
      sessionId: entry.sessionId,
      requestId: entry.requestId,
      executionId: entry.executionId,
      workflowId: entry.workflowId,
      stepId: entry.stepId,
    }),
    privacy: {
      redactionVersion: context.redactionVersion,
      capturePolicy: context.capturePolicy ?? "metadata-only",
      contentCaptured: context.contentCaptured ?? false,
      removedFields: [...new Set(context.removedFields ?? [])].sort(),
    },
    delivery: {
      spoolSequence: context.spoolSequence,
      flushWatermark: context.flushWatermark,
    },
    payload: compact({
      message: entry.message,
      data: entry.data,
      stack: entry.stack,
      tags: entry.tags,
      phase: entry.phase,
      attempt: entry.attempt,
      durationMs: entry.durationMs,
      source: entry.source,
      legacyEventId: entry.eventId,
    }),
  }
}

function legacyRuntime(runtime: ObservabilityRuntime): LogRuntime {
  switch (runtime) {
    case "browser":
    case "server":
    case "tauri":
    case "mcp":
    case "plugin":
    case "internal":
    case "unknown":
      return runtime
    default:
      return "unknown"
  }
}

function legacyOrigin(origin: string | undefined): LogOrigin | undefined {
  switch (origin) {
    case "frontend":
    case "web-runtime":
    case "tauri":
    case "mcp":
    case "plugin":
    case "diagnostic":
    case "unknown":
      return origin
    default:
      return undefined
  }
}

export function observabilityEventToStructuredLogEntry(
  event: ObservabilityEventV1
): StructuredLogEntry {
  const payload = event.payload
  return compact({
    id: event.eventId,
    timestamp: event.occurredAt,
    level: event.severity,
    message: payload.message,
    module: event.scope.module,
    traceId: event.correlation.traceId,
    requestId: event.correlation.requestId,
    executionId: event.correlation.executionId,
    workflowId: event.correlation.workflowId,
    stepId: event.correlation.stepId,
    eventId: payload.legacyEventId,
    code: event.code,
    runtime: legacyRuntime(event.scope.runtime),
    origin: legacyOrigin(event.scope.origin),
    sessionId: event.correlation.sessionId,
    spanId: event.correlation.spanId,
    parentSpanId: event.correlation.parentSpanId,
    phase: payload.phase,
    attempt: payload.attempt,
    durationMs: payload.durationMs,
    data: payload.data,
    stack: payload.stack,
    source: payload.source,
    tags: payload.tags,
  })
}
