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

import type { AgentTraceSpan, SpanEvent, SpanKind, SpanOperationName } from "./types"

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

/**
 * OTLP `Span.kind` enum (numeric per the proto):
 * 0 unspecified, 1 internal, 2 server, 3 client, 4 producer, 5 consumer.
 *
 * A span with no `spanKind` predates the field and really was internal, so it
 * maps to `internal` rather than `unspecified`.
 */
const OTLP_SPAN_KIND: Record<SpanKind, number> = {
  internal: 1,
  server: 2,
  client: 3,
}

/** OTLP `Status.code`: 0 unset, 1 ok, 2 error. */
const STATUS_UNSET = 0
const STATUS_OK = 1
const STATUS_ERROR = 2

/**
 * OpenInference `openinference.span.kind` — the attribute Phoenix / Arize and
 * a growing set of GenAI backends key their span rendering on. It is a
 * *semantic* role, orthogonal to the OTel `Span.kind` transport role above:
 * both are emitted because consumers read one or the other, never both.
 *
 * https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md
 */
const OPENINFERENCE_SPAN_KIND: Record<SpanOperationName, string> = {
  chat: "LLM",
  embeddings: "EMBEDDING",
  execute_tool: "TOOL",
  invoke_agent: "AGENT",
  invoke_workflow: "CHAIN",
  retrieval: "RETRIEVER",
}

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
  const attrs = buildSpanAttributes(span)
  const isError = Boolean(span.errorType || span.errorMessage)
  const out: OtlpSpan = {
    traceId: hexToBase64(span.traceId, 16),
    spanId: hexToBase64(span.spanId, 8),
    name: buildSpanName(span),
    kind: OTLP_SPAN_KIND[span.spanKind ?? "internal"] ?? OTLP_SPAN_KIND.internal,
    startTimeUnixNano: startNs,
    endTimeUnixNano: msToNanoString(effectiveEndTime(span)),
    attributes: attrs,
    status: {
      code: statusCode(span, isError),
      ...(isError && span.errorMessage ? { message: span.errorMessage } : {}),
    },
  }
  if (span.parentSpanId) out.parentSpanId = hexToBase64(span.parentSpanId, 8)
  if (span.events && span.events.length > 0) out.events = span.events.map(buildOtlpEvent)
  return out
}

/** True when the span never reached a terminal callback. */
function isUnfinished(span: AgentTraceSpan): boolean {
  return span.status === "pending" || span.status === "incomplete"
}

/**
 * End timestamp for the wire.
 *
 * A finished span carries its own. An *unfinished* one (`pending` /
 * `incomplete`) has none, and OTLP has no way to say "still open" — a zero
 * would make every consumer compute a negative duration. So the exported end is
 * the last moment the span was observed alive: its newest recorded event, or
 * its start. That is a lower bound on real duration rather than a claim the
 * work completed instantly, and `cognia.span.status` on the same span says
 * which of the two it is.
 */
function effectiveEndTime(span: AgentTraceSpan): number {
  if (typeof span.endTime === "number") return span.endTime
  let latest = span.startTime
  for (const event of span.events ?? []) {
    if (typeof event.at === "number" && event.at > latest) latest = event.at
  }
  return latest
}

/**
 * Map the span lifecycle onto the OTLP status code. An unfinished span has no
 * outcome yet, so it is `UNSET` — reporting `OK` would tell a backend the work
 * succeeded. Rows written before the `status` field fall back to the old
 * error-flag inference, which is exactly what they meant then.
 */
function statusCode(span: AgentTraceSpan, isError: boolean): number {
  if (isUnfinished(span)) return STATUS_UNSET
  if (span.status === "error" || isError) return STATUS_ERROR
  return STATUS_OK
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
  const openInferenceKind = OPENINFERENCE_SPAN_KIND[span.operationName]
  if (openInferenceKind) push("openinference.span.kind", strAttr(openInferenceKind))
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
    // The TTL split has no semconv attribute yet, so it rides as a vendor pair.
    // Without it a consumer cannot tell a 1.25x write from a 2x one.
    if (span.usage.cacheCreation5mTokens !== undefined) {
      push(
        "cognia.usage.cache_creation.ephemeral_5m.input_tokens",
        intAttr(span.usage.cacheCreation5mTokens)
      )
    }
    if (span.usage.cacheCreation1hTokens !== undefined) {
      push(
        "cognia.usage.cache_creation.ephemeral_1h.input_tokens",
        intAttr(span.usage.cacheCreation1hTokens)
      )
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
  // ADR-0090 execution identity — the join key between a span, its canonical
  // envelope and its billing row. Exported so an external backend can correlate
  // the same three substrates we correlate locally.
  if (span.runId) push("cognia.run.id", strAttr(span.runId))
  if (span.turnId) push("cognia.turn.id", strAttr(span.turnId))
  if (span.attemptId) push("cognia.attempt.id", strAttr(span.attemptId))
  if (span.projectId) push("cognia.project.id", strAttr(span.projectId))
  if (span.status) push("cognia.span.status", strAttr(span.status))
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
      if (!attr) continue
      // Keys with a real home get promoted rather than buried under the
      // vendor metadata bag, and are not emitted twice.
      push(PROMOTED_METADATA_ATTRIBUTES[k] ?? `cognia.metadata.${k}`, attr)
    }
  }
  return attrs
}

/**
 * Metadata keys that map onto a first-class attribute.
 *
 * These are the fields Claude Code's own OTel surface exposes on `api_request`,
 * `api_error` and `tool_result`. They were reaching the wire as
 * `cognia.metadata.*`, which no backend keys off — a tool-call id under a
 * vendor prefix cannot be joined to anything.
 */
const PROMOTED_METADATA_ATTRIBUTES: Readonly<Record<string, string>> = {
  toolUseId: "gen_ai.tool.call.id",
  requestId: "cognia.api.request_id",
  clientRequestId: "cognia.api.client_request_id",
  statusCode: "http.response.status_code",
  attempt: "cognia.attempt.number",
  toolInputSizeBytes: "cognia.tool.input_size_bytes",
  toolResultSizeBytes: "cognia.tool.result_size_bytes",
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
