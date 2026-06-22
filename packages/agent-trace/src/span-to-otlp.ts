/**
 * AgentTraceSpan → OTLP/HTTP JSON serializer.
 *
 * Produces the `ResourceSpans` payload accepted by every OpenTelemetry
 * Collector / Tempo / Grafana Cloud OTLP endpoint at `POST /v1/traces`.
 * We use the JSON encoding (Content-Type: application/json) to keep the
 * exporter dependency-free — no protobuf runtime needed.
 *
 * Naming follows the OTel GenAI semantic conventions (still "Development"
 * status as of late 2025 — the gen_ai.* namespace is the de-facto wire
 * format consumers like Phoenix / Langfuse / Datadog / Honeycomb all read).
 * Our `cognia.*` vendor attributes ride alongside on the same span.
 *
 * https://opentelemetry.io/docs/specs/semconv/gen-ai/
 * https://opentelemetry.io/docs/specs/otlp/#otlphttp
 */

import type { AgentTraceSpan, SpanEvent } from "./types"

/** Service identity attached to every batch. Configurable via the OTLP
 * transport options so users can tag traces with their own service name. */
export interface OtlpResourceMetadata {
  serviceName: string
  /** Optional `deployment.environment.name` (`production` / `staging` / etc.). */
  environment?: string
  /** Optional `service.version`. */
  serviceVersion?: string
}

const DEFAULT_RESOURCE: OtlpResourceMetadata = {
  serviceName: "cognia-ai",
}

const INSTRUMENTATION_SCOPE = {
  name: "cognia.agent-trace",
  version: "1.0.0",
} as const

/** OTLP `Span.kind` enum (numeric per the proto). All agent-trace spans
 * are internal — we're not modeling client/server boundaries here. */
const SPAN_KIND_INTERNAL = 1

/** OTLP `Status.code`: 0 unset, 1 ok, 2 error. */
const STATUS_OK = 1
const STATUS_ERROR = 2

export interface OtlpResourceSpans {
  resourceSpans: OtlpResourceSpan[]
}

interface OtlpResourceSpan {
  resource: { attributes: OtlpAttribute[] }
  scopeSpans: OtlpScopeSpan[]
}

interface OtlpScopeSpan {
  scope: { name: string; version: string }
  spans: OtlpSpan[]
}

interface OtlpSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: OtlpAttribute[]
  events?: OtlpEvent[]
  status?: { code: number; message?: string }
}

interface OtlpEvent {
  timeUnixNano: string
  name: string
  attributes?: OtlpAttribute[]
}

interface OtlpAttribute {
  key: string
  value: OtlpAttributeValue
}

type OtlpAttributeValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean }
  | { arrayValue: { values: OtlpAttributeValue[] } }

/** Serialise one finished span. Returns a `ResourceSpans` payload that can
 * be sent on its own (each span becomes a single-element scopeSpans array)
 * — callers typically want `spansToOtlp` instead which batches. */
export function spanToOtlp(
  span: AgentTraceSpan,
  resource: OtlpResourceMetadata = DEFAULT_RESOURCE
): OtlpResourceSpans {
  return {
    resourceSpans: [
      {
        resource: { attributes: buildResourceAttributes(resource) },
        scopeSpans: [
          {
            scope: { name: INSTRUMENTATION_SCOPE.name, version: INSTRUMENTATION_SCOPE.version },
            spans: [buildOtlpSpan(span)],
          },
        ],
      },
    ],
  }
}

/** Batch many spans into one OTLP payload. Same resource for every span;
 * spans are grouped under a single scopeSpans block (instrumentation scope
 * is fixed for our exporter). */
export function spansToOtlp(
  spans: AgentTraceSpan[],
  resource: OtlpResourceMetadata = DEFAULT_RESOURCE
): OtlpResourceSpans {
  return {
    resourceSpans: [
      {
        resource: { attributes: buildResourceAttributes(resource) },
        scopeSpans: [
          {
            scope: { name: INSTRUMENTATION_SCOPE.name, version: INSTRUMENTATION_SCOPE.version },
            spans: spans.map(buildOtlpSpan),
          },
        ],
      },
    ],
  }
}

function buildResourceAttributes(resource: OtlpResourceMetadata): OtlpAttribute[] {
  const attrs: OtlpAttribute[] = [
    { key: "service.name", value: { stringValue: resource.serviceName } },
  ]
  if (resource.environment) {
    attrs.push({
      key: "deployment.environment.name",
      value: { stringValue: resource.environment },
    })
  }
  if (resource.serviceVersion) {
    attrs.push({ key: "service.version", value: { stringValue: resource.serviceVersion } })
  }
  return attrs
}

function buildOtlpSpan(span: AgentTraceSpan): OtlpSpan {
  const startNs = msToNanoString(span.startTime)
  const endNs = msToNanoString(span.endTime ?? span.startTime)
  const attrs = buildSpanAttributes(span)
  const isError = Boolean(span.errorType || span.errorMessage)
  const out: OtlpSpan = {
    traceId: hexToBase64(span.traceId, 16),
    spanId: hexToBase64(span.spanId, 8),
    name: buildSpanName(span),
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: startNs,
    endTimeUnixNano: endNs,
    attributes: attrs,
    status: {
      code: isError ? STATUS_ERROR : STATUS_OK,
      ...(isError && span.errorMessage ? { message: span.errorMessage } : {}),
    },
  }
  if (span.parentSpanId) out.parentSpanId = hexToBase64(span.parentSpanId, 8)
  if (span.events && span.events.length > 0) out.events = span.events.map(buildOtlpEvent)
  return out
}

function buildSpanName(span: AgentTraceSpan): string {
  const subject =
    span.toolName ?? span.agentName ?? span.agentId ?? span.responseModel ?? span.requestModel
  if (subject) return `${span.operationName} ${subject}`
  return span.operationName
}

function buildSpanAttributes(span: AgentTraceSpan): OtlpAttribute[] {
  const attrs: OtlpAttribute[] = []
  const push = (key: string, value: OtlpAttributeValue | null | undefined): void => {
    if (value === null || value === undefined) return
    attrs.push({ key, value })
  }

  push("gen_ai.operation.name", strAttr(span.operationName))
  push("gen_ai.provider.name", strAttr(span.providerName))
  push("gen_ai.conversation.id", strAttr(span.sessionId))
  if (span.requestModel) push("gen_ai.request.model", strAttr(span.requestModel))
  if (span.responseModel) push("gen_ai.response.model", strAttr(span.responseModel))
  if (span.agentId) push("gen_ai.agent.id", strAttr(span.agentId))
  if (span.agentName) push("gen_ai.agent.name", strAttr(span.agentName))
  if (span.toolName) push("gen_ai.tool.name", strAttr(span.toolName))
  if (span.finishReasons && span.finishReasons.length > 0) {
    push("gen_ai.response.finish_reasons", arrayAttr(span.finishReasons.map(strAttr)))
  }
  if (span.usage) {
    push("gen_ai.usage.input_tokens", intAttr(span.usage.inputTokens))
    push("gen_ai.usage.output_tokens", intAttr(span.usage.outputTokens))
    if (span.usage.cacheReadTokens > 0) {
      push("gen_ai.usage.cache_read.input_tokens", intAttr(span.usage.cacheReadTokens))
    }
    if (span.usage.cacheCreationTokens > 0) {
      push("gen_ai.usage.cache_creation.input_tokens", intAttr(span.usage.cacheCreationTokens))
    }
  }
  if (typeof span.costUsdEstimate === "number" && span.costUsdEstimate > 0) {
    push("cognia.cost.usd_estimate", doubleAttr(span.costUsdEstimate))
  }
  if (span.errorType) push("error.type", strAttr(span.errorType))

  // Vendor (`cognia.*`) attributes — not part of the OTel GenAI spec but
  // ride alongside it. Most OTel-compatible backends accept arbitrary
  // attribute keys, just don't surface them in pre-built dashboards.
  push("cognia.surface", strAttr(span.surface))
  if (span.pluginId) push("cognia.plugin.id", strAttr(span.pluginId))
  if (span.handoff) {
    push("cognia.handoff.from_agent", strAttr(span.handoff.fromAgent))
    push("cognia.handoff.to_agent", strAttr(span.handoff.toAgent))
    if (span.handoff.reason) push("cognia.handoff.reason", strAttr(span.handoff.reason))
  }
  if (span.inputPreview) {
    push("gen_ai.input.messages", strAttr(truncate(span.inputPreview, 60_000)))
  }
  if (span.outputPreview) {
    push("gen_ai.output.messages", strAttr(truncate(span.outputPreview, 60_000)))
  }
  if (span.metadata) {
    for (const [k, v] of Object.entries(span.metadata)) {
      const attr = coerceAttribute(v)
      if (attr) push(`cognia.metadata.${k}`, attr)
    }
  }
  return attrs
}

function buildOtlpEvent(event: SpanEvent): OtlpEvent {
  const attributes: OtlpAttribute[] = []
  if (event.attributes) {
    for (const [k, v] of Object.entries(event.attributes)) {
      const attr = coerceAttribute(v)
      if (attr) attributes.push({ key: k, value: attr })
    }
  }
  return {
    timeUnixNano: msToNanoString(event.at),
    name: event.name,
    ...(attributes.length > 0 ? { attributes } : {}),
  }
}

function coerceAttribute(value: unknown): OtlpAttributeValue | null {
  if (value === null || value === undefined) return null
  if (typeof value === "string") return { stringValue: value }
  if (typeof value === "boolean") return { boolValue: value }
  if (typeof value === "number") {
    if (Number.isInteger(value)) return { intValue: String(value) }
    return { doubleValue: value }
  }
  if (Array.isArray(value)) {
    const inner = value.map(coerceAttribute).filter((v): v is OtlpAttributeValue => v !== null)
    return { arrayValue: { values: inner } }
  }
  if (typeof value === "object") {
    try {
      return { stringValue: JSON.stringify(value) }
    } catch {
      return null
    }
  }
  return null
}

function strAttr(s: string): OtlpAttributeValue {
  return { stringValue: s }
}
function intAttr(n: number): OtlpAttributeValue {
  return { intValue: String(Math.trunc(n)) }
}
function doubleAttr(n: number): OtlpAttributeValue {
  return { doubleValue: n }
}
function arrayAttr(values: OtlpAttributeValue[]): OtlpAttributeValue {
  return { arrayValue: { values } }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s
}

/** Convert epoch ms (number) to a stringified nanosecond timestamp — OTLP
 * carries timestamps as `uint64` rendered as string to preserve precision
 * beyond `Number.MAX_SAFE_INTEGER`. */
export function msToNanoString(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0"
  // 1 ms = 1_000_000 ns. String math avoids BigInt for the common path.
  return `${Math.trunc(ms)}000000`
}

/** Convert a hex string (lower-case, even length) to a base64 string.
 * OTLP/HTTP JSON encodes `bytes` fields with the canonical proto3 JSON
 * mapping — base64 — so this is the right form for traceId / spanId. */
export function hexToBase64(hex: string, expectedBytes: number): string {
  const cleaned = hex.toLowerCase()
  const expectedHexLen = expectedBytes * 2
  // Pad / truncate to the expected byte length so a malformed id can't
  // poison the entire batch.
  const normalized =
    cleaned.length === expectedHexLen
      ? cleaned
      : cleaned.length < expectedHexLen
        ? cleaned.padStart(expectedHexLen, "0")
        : cleaned.slice(0, expectedHexLen)
  const bytes = new Uint8Array(expectedBytes)
  for (let i = 0; i < expectedBytes; i++) {
    const byte = parseInt(normalized.substr(i * 2, 2), 16)
    bytes[i] = Number.isFinite(byte) ? byte : 0
  }
  let binary = ""
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return globalThis.btoa(binary)
}
