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

export function traceAsyncIterable(name, traceparent, attributes, iterable) {
  if (!sdk) return iterable
  const span = trace
    .getTracer("cognia.sidecar.anthropic")
    .startSpan(name, { attributes }, parentContext(traceparent))
  let ended = false
  const finish = (error) => {
    if (ended) return
    ended = true
    if (error) {
      span.recordException(error)
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(error?.message ?? error) })
    } else {
      span.setStatus({ code: SpanStatusCode.OK })
    }
    span.end()
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

export const __TESTING__ = { parseHeaders }
