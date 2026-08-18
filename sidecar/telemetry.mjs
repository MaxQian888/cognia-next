import { randomBytes } from "node:crypto"

import { ROOT_CONTEXT, SpanStatusCode, context, propagation, trace } from "@opentelemetry/api"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { NodeSDK } from "@opentelemetry/sdk-node"

let sdk = null
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
      registerTelemetry(new OpenTelemetry({ tracer: trace.getTracer("cognia.sidecar.ai-sdk") }))
    })
    .catch(() => {
      // Not the sidecar process (or the packages are absent) — allow a later
      // init to try again rather than latching the failure.
      aiTelemetryRegistered = false
    })
}

export function initializeTelemetry(env = process.env) {
  const endpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  if (!endpoint || sdk) return false
  sdk = new NodeSDK({
    serviceName: env.OTEL_SERVICE_NAME || "cognia-sidecar",
    traceExporter: new OTLPTraceExporter({
      url: endpoint,
      headers: parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS, env.COGNIA_OTEL_EXPORTER_HEADERS_JSON),
    }),
  })
  sdk.start()
  registerAiSdkTelemetry()
  return true
}

export async function shutdownTelemetry() {
  const current = sdk
  sdk = null
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
    metadata: { sessionId, traceId },
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
  if (!sdk && typeof localEmit !== "function") return iterable

  const span = sdk
    ? trace
        .getTracer("cognia.sidecar.anthropic")
        .startSpan(name, { attributes }, parentContext(traceparent))
    : null
  const startTime = Date.now()
  const spanId = randomSpanId()
  let ended = false
  const finish = (error) => {
    if (ended) return
    ended = true
    if (span) {
      if (error) {
        span.recordException(error)
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(error?.message ?? error) })
      } else {
        span.setStatus({ code: SpanStatusCode.OK })
      }
      span.end()
    }
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

export const __TESTING__ = { parseHeaders, randomSpanId }
