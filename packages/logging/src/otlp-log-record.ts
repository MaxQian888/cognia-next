import type { LogLevel, StructuredLogEntry } from "./types"

export interface OtlpLogResourceMetadata {
  serviceName?: string
  serviceVersion?: string
  environment?: string
}

export type OtlpLogAnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean }
  | { arrayValue: { values: OtlpLogAnyValue[] } }

export interface OtlpLogAttribute {
  key: string
  value: OtlpLogAnyValue
}

export interface OtlpLogRecord {
  timeUnixNano: string
  observedTimeUnixNano: string
  severityNumber: number
  severityText: string
  body: { stringValue: string }
  attributes: OtlpLogAttribute[]
  traceId?: string
  spanId?: string
  flags?: number
}

export interface OtlpResourceLogs {
  resourceLogs: Array<{
    resource: { attributes: OtlpLogAttribute[] }
    scopeLogs: Array<{
      scope: { name: string; version: string }
      logRecords: OtlpLogRecord[]
    }>
  }>
}

const DEFAULT_RESOURCE: Required<Pick<OtlpLogResourceMetadata, "serviceName">> = {
  serviceName: "cognia-ai",
}

const OTLP_SEVERITY_NUMBER: Record<LogLevel, number> = {
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
}

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/i
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/i

export function structuredLogEntriesToOtlpLogs(
  entries: StructuredLogEntry[],
  resource: OtlpLogResourceMetadata = DEFAULT_RESOURCE
): OtlpResourceLogs {
  return {
    resourceLogs: [
      {
        resource: { attributes: resourceAttributes(resource) },
        scopeLogs: [
          {
            scope: { name: "@cognia/logging", version: "1.0.0" },
            logRecords: entries.map(toLogRecord),
          },
        ],
      },
    ],
  }
}

function toLogRecord(entry: StructuredLogEntry): OtlpLogRecord {
  const timeUnixNano = isoToNanoString(entry.timestamp)
  const record: OtlpLogRecord = {
    timeUnixNano,
    observedTimeUnixNano: timeUnixNano,
    severityNumber: OTLP_SEVERITY_NUMBER[entry.level],
    severityText: entry.level.toUpperCase(),
    body: { stringValue: entry.message },
    attributes: entryAttributes(entry),
  }

  if (validTraceId(entry.traceId) && validSpanId(entry.spanId)) {
    // OTLP/JSON deliberately differs from protobuf's generic JSON mapping:
    // trace and span byte fields are encoded as hexadecimal strings.
    record.traceId = entry.traceId.toLowerCase()
    record.spanId = entry.spanId.toLowerCase()
    record.flags = 1
  }

  return record
}

function resourceAttributes(resource: OtlpLogResourceMetadata): OtlpLogAttribute[] {
  const attributes: OtlpLogAttribute[] = [
    {
      key: "service.name",
      value: { stringValue: resource.serviceName?.trim() || DEFAULT_RESOURCE.serviceName },
    },
  ]
  pushString(attributes, "service.version", resource.serviceVersion)
  pushString(attributes, "deployment.environment.name", resource.environment)
  return attributes
}

function entryAttributes(entry: StructuredLogEntry): OtlpLogAttribute[] {
  const attributes: OtlpLogAttribute[] = [
    { key: "log.record.uid", value: { stringValue: entry.id } },
  ]
  pushString(attributes, "event.name", entry.code)
  pushString(attributes, "code.namespace", entry.module)
  pushString(attributes, "cognia.runtime", entry.runtime)
  pushString(attributes, "cognia.origin", entry.origin)
  pushString(attributes, "session.id", entry.sessionId)
  pushString(attributes, "cognia.request.id", entry.requestId)
  pushString(attributes, "cognia.parent_span.id", entry.parentSpanId)
  pushString(attributes, "cognia.execution.id", entry.executionId)
  pushString(attributes, "cognia.workflow.id", entry.workflowId)
  pushString(attributes, "cognia.step.id", entry.stepId)
  pushString(attributes, "cognia.event.id", entry.eventId)
  pushString(attributes, "cognia.phase", entry.phase)
  if (entry.attempt !== undefined && Number.isFinite(entry.attempt)) {
    attributes.push({
      key: "cognia.attempt",
      value: { intValue: String(Math.trunc(entry.attempt)) },
    })
  }
  if (entry.durationMs !== undefined && Number.isFinite(entry.durationMs)) {
    attributes.push({ key: "cognia.duration_ms", value: { doubleValue: entry.durationMs } })
  }
  if (entry.tags?.length) {
    attributes.push({
      key: "cognia.tags",
      value: {
        arrayValue: {
          values: entry.tags.map((tag) => ({ stringValue: tag })),
        },
      },
    })
  }
  const data = safeJson(entry.data)
  if (data) pushString(attributes, "cognia.log.data", data)
  pushString(attributes, "exception.stacktrace", entry.stack)
  pushString(attributes, "code.file.path", entry.source?.file)
  pushString(attributes, "code.function.name", entry.source?.function)
  if (entry.source?.line !== undefined && Number.isFinite(entry.source.line)) {
    attributes.push({
      key: "code.line.number",
      value: { intValue: String(Math.trunc(entry.source.line)) },
    })
  }
  return attributes
}

function pushString(attributes: OtlpLogAttribute[], key: string, value?: string): void {
  if (!value) return
  attributes.push({ key, value: { stringValue: value } })
}

function safeJson(value: unknown): string | undefined {
  if (value === undefined) return undefined
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

function isoToNanoString(value: string): string {
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) && milliseconds >= 0
    ? `${Math.trunc(milliseconds)}000000`
    : "0"
}

function validTraceId(value?: string): value is string {
  return Boolean(value && TRACE_ID_PATTERN.test(value) && !/^0+$/.test(value))
}

function validSpanId(value?: string): value is string {
  return Boolean(value && SPAN_ID_PATTERN.test(value) && !/^0+$/.test(value))
}
