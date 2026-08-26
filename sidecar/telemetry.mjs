import { randomBytes } from "node:crypto"

import { ROOT_CONTEXT, context, propagation, trace } from "@opentelemetry/api"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { NodeSDK } from "@opentelemetry/sdk-node"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { PostHogTraceExporter } from "@posthog/ai/otel"
import { hasNoLeakingPiiDeep } from "@cognia/redact"

let sdk = null
let installationId = ""
let captureModelContent = false
let captureToolContent = false

const LANGFUSE_METADATA_PREFIX = "langfuse.observation.metadata."

/**
 * Keep Cognia correlation attributes independent from any single AI SDK
 * integration. Langfuse's official integration records runtime context as
 * observation metadata; this processor mirrors the small, non-content subset
 * that generic OTLP and PostHog already relied on.
 */
class CogniaCorrelationSpanProcessor {
  onStart(span) {
    const metadata = (key) => span.attributes?.[`${LANGFUSE_METADATA_PREFIX}${key}`]
    const mapped = {
      "gen_ai.conversation.id": metadata("cogniaSessionId"),
      "cognia.trace_id": metadata("cogniaTraceId"),
      "cognia.surface": metadata("cogniaSurface"),
      "cognia.run.id": metadata("cogniaRunId"),
      "cognia.turn.id": metadata("cogniaTurnId"),
      "cognia.attempt.id": metadata("cogniaAttemptId"),
      "cognia.project.id": metadata("cogniaProjectId"),
    }
    for (const [key, value] of Object.entries(mapped)) {
      const bounded = boundedAttributeValue(value)
      if (bounded !== undefined) span.setAttribute(key, bounded)
    }
    if (installationId) span.setAttribute("posthog.distinct_id", installationId.slice(0, 512))
  }

  onEnd() {}

  forceFlush() {
    return Promise.resolve()
  }

  shutdown() {
    return Promise.resolve()
  }
}
/**
 * AI SDK 7 moved OpenTelemetry span collection out of the `ai` package: it no
 * longer emits spans just because a call passes telemetry options. The
 * integration is registered once, PROCESS-WIDE, from Langfuse's official
 * AI SDK 7 integration.
 *
 * Registration is deliberately tied to `sdk` being live: v7 telemetry is
 * opt-OUT once an integration exists, so registering with no OTLP endpoint
 * configured would start producing spans in a process that has no exporter —
 * the opposite of the current "no endpoint means completely silent" behaviour.
 */
let aiTelemetryRegistered = false

/**
 * Register before the first request; a duplicate process-global integration
 * would produce duplicate generation and tool observations.
 *
 * `ai` and `@langfuse/vercel-ai-sdk` are loaded LAZILY, and the Langfuse
 * integration is a sidecar-only dependency (it is not in the root manifest, and
 * it pulls in ESM-only `@ai-sdk/otel`). A static import would make this module
 * unloadable from the renderer/root context, which does import the adapter
 * chain — `protocol-adapter-spec.parity.test.ts` reaches `registry.mjs` →
 * `ai-sdk-adapter.mjs` → here.
 *
 * A failed load therefore means "not the sidecar process", where collecting AI
 * SDK spans would be meaningless anyway: swallow it and leave telemetry
 * unregistered. `initializeTelemetry` still reports success, because the OTLP
 * exporter itself (the part this process does own) did start.
 *
 * The import settles on a microtask, long before the first model call, which
 * only happens after the IPC handshake.
 */
function registerAiSdkTelemetry() {
  if (aiTelemetryRegistered) return
  // Set before awaiting so two calls in the same tick can't both register —
  // `registerTelemetry` appends to a process-global list and a duplicate would
  // double every span.
  aiTelemetryRegistered = true
  Promise.all([import("ai"), import("@langfuse/vercel-ai-sdk")])
    .then(([{ registerTelemetry }, { LangfuseVercelAiSdkIntegration }]) => {
      registerTelemetry(
        new LangfuseVercelAiSdkIntegration({
          tracer: trace.getTracer("cognia.sidecar.ai-sdk"),
        })
      )
    })
    .catch(() => {
      // Not the sidecar process (or the packages are absent) — allow a later
      // init to try again rather than latching the failure.
      aiTelemetryRegistered = false
    })
}

const LANGFUSE_CONTENT_ATTRIBUTE =
  /(?:^|[._])(?:input|output|inputs|outputs|prompt|completion|content|messages|instructions|arguments|result|tool_calls?)$/i

function sanitizeLangfuseValue(value, maxStringBytes = 512) {
  if (typeof value === "string") {
    if (!hasNoLeakingPiiDeep(value)) return undefined
    return value.slice(0, maxStringBytes)
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value === "boolean") return value
  if (Array.isArray(value)) {
    return value
      .slice(0, 32)
      .map((item) => sanitizeLangfuseValue(item, maxStringBytes))
      .filter((item) => item !== undefined)
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 64)
        .flatMap(([key, item]) => {
          if (!hasNoLeakingPiiDeep(key)) return []
          const safe = sanitizeLangfuseValue(item, maxStringBytes)
          return safe === undefined ? [] : [[key, safe]]
        })
    )
  }
  return undefined
}

function contentAllowed(kind) {
  return kind === "tool" ? captureToolContent : captureModelContent
}

function semanticContentKind(value, inherited) {
  if (!value || typeof value !== "object") return inherited
  const role = String(value.role ?? "").toLowerCase()
  const type = String(value.type ?? "").toLowerCase()
  if (role === "tool" || type.includes("tool")) return "tool"
  if (["system", "user", "assistant"].includes(role)) return "model"
  if (/(?:text|reasoning|image|audio)/.test(type)) return "model"
  return inherited
}

function sanitizeSemanticContent(value, inheritedKind) {
  const kind = semanticContentKind(value, inheritedKind)
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return kind && contentAllowed(kind) ? sanitizeLangfuseValue(value, 4096) : undefined
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 32)
      .map((item) => sanitizeSemanticContent(item, kind))
      .filter((item) => item !== undefined)
  }
  if (!value || typeof value !== "object") return undefined
  const safeObject = Object.fromEntries(
    Object.entries(value)
      .slice(0, 64)
      .flatMap(([key, item]) => {
        if (!hasNoLeakingPiiDeep(key)) return []
        const fieldKind = /(?:arguments?|args|results?|toolCallId|toolName)/i.test(key)
          ? "tool"
          : /(?:text|content|instructions?|prompt|completion)/i.test(key)
            ? (kind ?? "model")
            : kind
        const safe = sanitizeSemanticContent(item, fieldKind)
        return safe === undefined ? [] : [[key, safe]]
      })
  )
  return Object.keys(safeObject).length > 0 ? safeObject : undefined
}

function sanitizeMixedLangfuseContent(value) {
  let decoded = value
  let wasJsonString = false
  if (typeof value === "string") {
    try {
      decoded = JSON.parse(value)
      wasJsonString = true
    } catch {
      // An opaque input/output string cannot prove it excludes the other
      // consent class. Fail closed unless both classes were authorized.
      return captureModelContent && captureToolContent
        ? sanitizeLangfuseValue(value, 4096)
        : undefined
    }
  }
  const safe = sanitizeSemanticContent(decoded, undefined)
  if (safe === undefined || !hasNoLeakingPiiDeep(safe)) return undefined
  return wasJsonString ? JSON.stringify(safe) : safe
}

function sanitizeLangfuseContentAttribute(key, value, isToolObservation) {
  if (isToolObservation || /(?:arguments?|args|results?|tool_calls?)(?:$|\.)/i.test(key)) {
    return captureToolContent ? sanitizeLangfuseValue(value, 4096) : undefined
  }
  if (/(?:instructions?|prompt|completion)(?:$|\.)/i.test(key)) {
    return captureModelContent ? sanitizeLangfuseValue(value, 4096) : undefined
  }
  return sanitizeMixedLangfuseContent(value)
}

function sanitizeLangfuseReadableSpan(span) {
  const source = span.attributes ?? {}
  const observationType = String(source["langfuse.observation.type"] ?? "").toLowerCase()
  const operation = String(source["gen_ai.operation.name"] ?? "").toLowerCase()
  const isTool = observationType === "tool" || operation === "execute_tool"
  const captureContent = isTool ? captureToolContent : captureModelContent
  const attributes = Object.fromEntries(
    Object.entries(source).flatMap(([key, value]) => {
      const isContent = LANGFUSE_CONTENT_ATTRIBUTE.test(key)
      if (isContent && !captureContent && !(captureModelContent || captureToolContent)) return []
      const safe = isContent
        ? sanitizeLangfuseContentAttribute(key, value, isTool)
        : sanitizeLangfuseValue(value, 512)
      return safe === undefined ? [] : [[key, safe]]
    })
  )
  const overrides = {
    attributes,
    resource: sanitizeResource(span.resource),
    status: span.status ? { code: span.status.code } : span.status,
    links: [],
    events: [],
    instrumentationScope: span.instrumentationScope
      ? {
          name: sanitizeLangfuseValue(span.instrumentationScope.name, 128) ?? "cognia.ai-sdk",
          version: sanitizeLangfuseValue(span.instrumentationScope.version, 64),
        }
      : span.instrumentationScope,
  }
  const safeName = sanitizeLangfuseValue(span.name, 128) ?? "llm.generate"
  const sanitized = new Proxy(span, {
    get(target, property, receiver) {
      if (property === "name") return safeName
      if (Object.hasOwn(overrides, property)) return overrides[property]
      const value = Reflect.get(target, property, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  return isPrivacySafeReadableSpan(sanitized) ? sanitized : undefined
}

class LazyLangfuseSpanProcessor {
  constructor(env) {
    const config = {
      publicKey: env.LANGFUSE_PUBLIC_KEY,
      secretKey: env.LANGFUSE_SECRET_KEY,
      baseUrl: env.LANGFUSE_BASE_URL,
      environment: env.LANGFUSE_ENVIRONMENT,
      release: env.LANGFUSE_RELEASE,
    }
    this.processor = import("@langfuse/otel").then(
      ({ LangfuseSpanProcessor }) =>
        new LangfuseSpanProcessor({
          ...config,
          exportMode: "batched",
          mediaUploadEnabled: false,
          mask: ({ data }) => sanitizeLangfuseValue(data, 4096),
        })
    )
  }

  onStart(span, parentContext) {
    void this.processor.then((processor) => processor.onStart(span, parentContext))
  }

  onEnd(span) {
    const sanitized = sanitizeLangfuseReadableSpan(span)
    if (sanitized) void this.processor.then((processor) => processor.onEnd(sanitized))
  }

  forceFlush() {
    return this.processor.then((processor) => processor.forceFlush())
  }

  shutdown() {
    return this.processor.then((processor) => processor.shutdown())
  }
}

export function initializeTelemetry(env = process.env) {
  const endpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  const posthogDestinations = parsePostHogDestinations(env.COGNIA_POSTHOG_DESTINATIONS_JSON)
  const langfuseEnabled =
    env.COGNIA_LANGFUSE_TRACING_DISABLED !== "1" &&
    env.NEXT_PUBLIC_LANGFUSE_TRACING_DISABLED !== "1" &&
    Boolean(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY && env.LANGFUSE_BASE_URL)
  if ((!endpoint && posthogDestinations.length === 0 && !langfuseEnabled) || sdk) return false
  installationId = String(env.COGNIA_OBSERVABILITY_INSTALLATION_ID ?? "").trim()
  captureModelContent = env.COGNIA_LANGFUSE_CAPTURE_MODEL_CONTENT === "true"
  captureToolContent = env.COGNIA_LANGFUSE_CAPTURE_TOOL_CONTENT === "true"
  const spanProcessors = [new CogniaCorrelationSpanProcessor()]
  if (endpoint) {
    spanProcessors.push(
      new BatchSpanProcessor(
        new PrivacyFilteringSpanExporter(
          new OTLPTraceExporter({
            url: endpoint,
            headers: parseHeaders(
              env.OTEL_EXPORTER_OTLP_HEADERS,
              env.COGNIA_OTEL_EXPORTER_HEADERS_JSON
            ),
          })
        ),
        { maxExportBatchSize: 16 }
      )
    )
  }
  for (const destination of posthogDestinations) {
    spanProcessors.push(
      new BatchSpanProcessor(
        new PrivacyFilteringSpanExporter(
          new PostHogTraceExporter({
            projectToken: destination.projectToken,
            host: destination.host,
          })
        ),
        { maxExportBatchSize: 16 }
      )
    )
  }
  if (langfuseEnabled) spanProcessors.push(new LazyLangfuseSpanProcessor(env))
  scrubLangfuseSecretEnvironment(env)
  sdk = new NodeSDK({
    serviceName: env.OTEL_SERVICE_NAME || "cognia-sidecar",
    spanProcessors,
  })
  sdk.start()
  registerAiSdkTelemetry()
  return true
}

function scrubLangfuseSecretEnvironment(env) {
  if (!env || typeof env !== "object") return
  delete env.LANGFUSE_SECRET_KEY
}

const PRIVATE_ATTRIBUTE_KEYS = new Set([
  "gen_ai.system_instructions",
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.tool.definitions",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
  "ai.prompt",
  "ai.response",
  "exception.message",
  "exception.stacktrace",
])

const ALLOWED_ATTRIBUTE_KEYS = new Set([
  "gen_ai.operation.name",
  "gen_ai.provider.name",
  "gen_ai.conversation.id",
  "gen_ai.request.model",
  "gen_ai.response.model",
  "gen_ai.tool.name",
  "gen_ai.tool.call.id",
  "openinference.span.kind",
  "posthog.distinct_id",
  "error.type",
  "http.response.status_code",
  "server.address",
])

const ALLOWED_RESOURCE_ATTRIBUTE_KEYS = new Set([
  "service.name",
  "service.version",
  "deployment.environment.name",
  "telemetry.sdk.name",
  "telemetry.sdk.language",
  "telemetry.sdk.version",
])

function isAllowedAttributeKey(key) {
  return (
    ALLOWED_ATTRIBUTE_KEYS.has(key) ||
    /^gen_ai\.usage\./.test(key) ||
    /^cognia\.(?:trace_id|cost\.|surface$|span\.status$|usage\.|(?:run|turn|attempt|project|plugin)\.id$)/.test(
      key
    )
  )
}

function boundedAttributeValue(value) {
  if (typeof value === "string") return value.slice(0, 512)
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "boolean") return value
  if (Array.isArray(value)) {
    return value
      .slice(0, 16)
      .map(boundedAttributeValue)
      .filter((item) => item !== undefined)
  }
  return undefined
}

function sanitizeAttributes(attributes = {}) {
  return Object.fromEntries(
    Object.entries(attributes)
      .slice(0, 32)
      .flatMap(([key, value]) => {
        if (PRIVATE_ATTRIBUTE_KEYS.has(key)) return []
        if (
          /(?:^|\.)(?:prompt|completion|content|system_prompt|schema|arguments?|results?|inputs?|outputs?|exception|stack|message|body|file|path|url|referrer)(?:$|\.)/i.test(
            key
          ) ||
          !isAllowedAttributeKey(key)
        ) {
          return []
        }
        const bounded = boundedAttributeValue(value)
        return bounded === undefined ? [] : [[key, bounded]]
      })
  )
}

function sanitizeResource(resource) {
  if (!resource || typeof resource !== "object") return resource
  const attributes = Object.fromEntries(
    Object.entries(resource.attributes ?? {}).flatMap(([key, value]) => {
      if (!ALLOWED_RESOURCE_ATTRIBUTE_KEYS.has(key)) return []
      const bounded = boundedAttributeValue(value)
      return bounded === undefined ? [] : [[key, bounded]]
    })
  )
  return new Proxy(resource, {
    get(target, property, receiver) {
      if (property === "attributes") return attributes
      const value = Reflect.get(target, property, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

function sanitizeReadableSpan(span) {
  const overrides = {
    attributes: sanitizeAttributes(span.attributes),
    resource: sanitizeResource(span.resource),
    status: span.status ? { code: span.status.code } : span.status,
    links: [],
    events: (span.events ?? [])
      .filter((event) => !/(?:exception|error|message|prompt|content)/i.test(event.name))
      .slice(0, 8)
      .map((event) => ({
        ...event,
        attributes: sanitizeAttributes(event.attributes),
      })),
  }
  return new Proxy(span, {
    get(target, property, receiver) {
      if (Object.hasOwn(overrides, property)) return overrides[property]
      const value = Reflect.get(target, property, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

function isPrivacySafeReadableSpan(span) {
  return hasNoLeakingPiiDeep({
    name: span.name,
    attributes: span.attributes,
    resourceAttributes: span.resource?.attributes,
    instrumentationScope: span.instrumentationScope,
    events: span.events,
  })
}

class PrivacyFilteringSpanExporter {
  constructor(delegate) {
    this.delegate = delegate
  }

  export(spans, resultCallback) {
    const safeSpans = spans.map(sanitizeReadableSpan).filter(isPrivacySafeReadableSpan)
    if (safeSpans.length === 0) {
      resultCallback({ code: 0 })
      return
    }
    this.delegate.export(safeSpans, resultCallback)
  }

  shutdown() {
    return this.delegate.shutdown()
  }

  forceFlush() {
    return typeof this.delegate.forceFlush === "function"
      ? this.delegate.forceFlush()
      : Promise.resolve()
  }
}

function parsePostHogDestinations(value) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const host = typeof item.host === "string" ? item.host.trim().replace(/\/$/, "") : ""
      const projectToken = typeof item.projectToken === "string" ? item.projectToken.trim() : ""
      try {
        const url = new URL(host)
        if (
          projectToken.length <= "phc_".length ||
          !projectToken.startsWith("phc_") ||
          /\s/.test(projectToken) ||
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        ) {
          return []
        }
      } catch {
        return []
      }
      return [{ id: String(item.id ?? "posthog"), host, projectToken }]
    })
  } catch {
    return []
  }
}

export async function shutdownTelemetry() {
  const current = sdk
  sdk = null
  installationId = ""
  captureModelContent = false
  captureToolContent = false
  if (current) await current.shutdown()
}

function parseHeaders(value, jsonValue) {
  if (jsonValue) {
    try {
      const parsed = JSON.parse(jsonValue)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed
    } catch {
      // Fall through to the standard OTEL key=value syntax.
    }
  }
  if (!value) return undefined
  return Object.fromEntries(
    value
      .split(",")
      .map((part) => {
        const separator = part.indexOf("=")
        return separator < 0
          ? ["", ""]
          : [part.slice(0, separator).trim(), part.slice(separator + 1).trim()]
      })
      .filter(([key, itemValue]) => key && itemValue)
  )
}

export function parentContext(traceparent) {
  if (typeof traceparent !== "string" || traceparent.length === 0) return ROOT_CONTEXT
  return propagation.extract(ROOT_CONTEXT, { traceparent })
}

export function withTraceparent(traceparent, callback) {
  return context.with(parentContext(traceparent), callback)
}

export function aiSdkTelemetry({
  sessionId,
  traceId,
  surface,
  runId,
  turnId,
  attemptId,
  projectId,
  feature,
  promptComponentIds,
  promptVersion,
  promptFingerprint,
  provider,
  traceparent,
}) {
  if (!sdk) return undefined
  const runtimeContext = Object.fromEntries(
    Object.entries({
      cogniaSessionId: sessionId,
      cogniaTraceId: traceId,
      cogniaSurface: surface,
      cogniaRunId: runId,
      cogniaTurnId: turnId,
      cogniaAttemptId: attemptId,
      cogniaProjectId: projectId,
      cogniaFeature: feature,
      cogniaPromptComponentIds: promptComponentIds,
      cogniaPromptVersion: promptVersion,
      cogniaPromptFingerprint: promptFingerprint,
    }).filter(([, value]) => value !== undefined)
  )
  return {
    // `isEnabled: true` is gone: in v7 telemetry is on by default once an
    // integration is registered, and `initializeTelemetry` only registers when
    // at least one trace destination exists. `tracer` is gone too — v7 removed
    // it from the per-call options; the custom tracer now lives on the
    // integration built at process startup.
    functionId: `cognia.sidecar.${provider || "unknown"}`,
    runtimeContext,
    includeRuntimeContext: Object.fromEntries(
      Object.keys(runtimeContext).map((key) => [key, true])
    ),
    // Content enters spans only when either explicit Langfuse consent is on.
    // Destination processors still enforce model/tool consent independently;
    // generic OTLP and PostHog always strip content.
    recordInputs: captureModelContent || captureToolContent,
    recordOutputs: captureModelContent || captureToolContent,
    traceparent,
  }
}

/**
 * Random lower-case hex, for a locally-minted span id. `randomUUID` is not
 * usable here: OTLP span ids are 8 bytes, not 16.
 */
function randomSpanId() {
  const bytes = randomBytes(8)
  let out = ""
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0")
  return out
}

/**
 * Emit one finished sidecar span back to the renderer.
 *
 * Repatriation, not export: the sidecar's spans used to exist ONLY as OTLP, so
 * a default install — which configures no collector — recorded nothing at all
 * for the half of every turn that runs out-of-process. The renderer's waterfall
 * showed a `chat` span with a multi-second gap in the middle and no way to see
 * inside it.
 *
 * The `traceparent` is echoed back verbatim rather than parsed here: the
 * renderer minted it and already owns a parser (`lib/agent-trace/trace-context`),
 * so echoing keeps exactly one implementation of the W3C wire format.
 */
function emitLocalSpan(emit, span) {
  if (typeof emit !== "function") return
  try {
    emit({ type: "agent_trace_span", ...span })
  } catch {
    // A span must never break the stream it was measuring.
  }
}

/**
 * Wrap an async iterable so the work it drives is measured.
 *
 * Two independent sinks, either of which may be absent:
 *  - the OTel SDK, when an OTLP endpoint is configured;
 *  - `options.emit`, which repatriates the span to the local renderer.
 *
 * With neither, the iterable is returned untouched so there is no proxy on the
 * hot path.
 *
 * @param {{ emit?: (event: any) => void, sessionId?: string,
 *           operationName?: string, providerName?: string }} [options]
 */
export function traceAsyncIterable(name, traceparent, attributes, iterable, options = {}) {
  const localEmit = options.emit
  // AI SDK spans are exported by the sidecar. Manually wrapped Anthropic spans
  // are repatriated and owned by the renderer so they are never exported twice.
  if (typeof localEmit !== "function") return iterable
  const startTime = Date.now()
  const spanId = randomSpanId()
  let ended = false
  const finish = (error) => {
    if (ended) return
    ended = true
    const endTime = Date.now()
    emitLocalSpan(localEmit, {
      sessionId: options.sessionId,
      traceparent,
      spanId,
      name,
      operationName: options.operationName ?? "invoke_agent",
      providerName: options.providerName ?? "anthropic",
      startTime,
      endTime,
      durationMs: Math.max(0, endTime - startTime),
      attributes,
      ...(error
        ? {
            errorType: error?.name ? String(error.name) : "sidecar_error",
            errorMessage: String(error?.message ?? error),
          }
        : {}),
    })
  }
  return new Proxy(iterable, {
    get(target, property, receiver) {
      if (property !== Symbol.asyncIterator) {
        const value = Reflect.get(target, property, receiver)
        return typeof value === "function" ? value.bind(target) : value
      }
      return async function* () {
        try {
          yield* target
          finish()
        } catch (error) {
          finish(error)
          throw error
        } finally {
          finish()
        }
      }
    },
  })
}

export const __TESTING__ = {
  parseHeaders,
  parsePostHogDestinations,
  randomSpanId,
  PrivacyFilteringSpanExporter,
  CogniaCorrelationSpanProcessor,
  sanitizeReadableSpan,
  sanitizeLangfuseReadableSpan,
  scrubLangfuseSecretEnvironment,
}
