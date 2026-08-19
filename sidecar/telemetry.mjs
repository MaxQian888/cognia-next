import { randomBytes } from "node:crypto"

import { ROOT_CONTEXT, context, propagation, trace } from "@opentelemetry/api"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { NodeSDK } from "@opentelemetry/sdk-node"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { PostHogTraceExporter } from "@posthog/ai/otel"

let sdk = null
let installationId = ""
/**
 * AI SDK 7 moved OpenTelemetry span collection out of the `ai` package: it no
 * longer emits spans just because a call passes telemetry options. The
 * integration is registered once, PROCESS-WIDE, from `@ai-sdk/otel`.
 *
 * Registration is deliberately tied to `sdk` being live: v7 telemetry is
 * opt-OUT once an integration exists, so registering with no OTLP endpoint
 * configured would start producing spans in a process that has no exporter —
 * the opposite of the current "no endpoint means completely silent" behaviour.
 */
let aiTelemetryRegistered = false

/**
 * `ai` and `@ai-sdk/otel` are loaded LAZILY, and `@ai-sdk/otel` is a
 * sidecar-only dependency (it is not in the root manifest). A static import
 * would make this module unloadable from the renderer/root context, which does
 * import the adapter chain — `protocol-adapter-spec.parity.test.ts` reaches
 * `registry.mjs` → `ai-sdk-adapter.mjs` → here. Both packages are also ESM-only
 * in v7, so `createRequire` is not an option.
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
  // `registerTelemetry` appends to a module-global list and a duplicate would
  // double every span.
  aiTelemetryRegistered = true
  Promise.all([import("ai"), import("@ai-sdk/otel")])
    .then(([{ registerTelemetry }, { OpenTelemetry }]) => {
      registerTelemetry(
        new OpenTelemetry({
          tracer: trace.getTracer("cognia.sidecar.ai-sdk"),
          enrichSpan: ({ runtimeContext }) => ({
            "gen_ai.conversation.id": runtimeContext?.cogniaSessionId,
            "cognia.trace_id": runtimeContext?.cogniaTraceId,
            "posthog.distinct_id": installationId || undefined,
          }),
        })
      )
    })
    .catch(() => {
      // Not the sidecar process (or the packages are absent) — allow a later
      // init to try again rather than latching the failure.
      aiTelemetryRegistered = false
    })
}

export function initializeTelemetry(env = process.env) {
  const endpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  const posthogDestinations = parsePostHogDestinations(env.COGNIA_POSTHOG_DESTINATIONS_JSON)
  if ((!endpoint && posthogDestinations.length === 0) || sdk) return false
  installationId = String(env.COGNIA_OBSERVABILITY_INSTALLATION_ID ?? "").trim()
  const spanProcessors = []
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
  sdk = new NodeSDK({
    serviceName: env.OTEL_SERVICE_NAME || "cognia-sidecar",
    spanProcessors,
  })
  sdk.start()
  registerAiSdkTelemetry()
  return true
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

function sanitizeReadableSpan(span) {
  const overrides = {
    attributes: sanitizeAttributes(span.attributes),
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

class PrivacyFilteringSpanExporter {
  constructor(delegate) {
    this.delegate = delegate
  }

  export(spans, resultCallback) {
    this.delegate.export(spans.map(sanitizeReadableSpan), resultCallback)
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
          !projectToken.startsWith("phc_") ||
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

export function aiSdkTelemetry({ sessionId, traceId, provider, traceparent }) {
  if (!sdk) return undefined
  return {
    // `isEnabled: true` is gone: in v7 telemetry is on by default once an
    // integration is registered, and `initializeTelemetry` only registers when
    // an OTLP endpoint exists. `tracer` is gone too — v7 removed it from the
    // per-call options; the custom tracer now lives on the `OpenTelemetry`
    // instance built at registration.
    functionId: `cognia.sidecar.${provider || "unknown"}`,
    runtimeContext: { cogniaSessionId: sessionId, cogniaTraceId: traceId },
    // Privacy contract, unchanged: prompts and completions never enter a span.
    recordInputs: false,
    recordOutputs: false,
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
  sanitizeReadableSpan,
}
