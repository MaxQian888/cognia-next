import { ROOT_CONTEXT, SpanStatusCode, context, propagation, trace } from "@opentelemetry/api"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { NodeSDK } from "@opentelemetry/sdk-node"

let sdk = null

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
    isEnabled: true,
    functionId: `cognia.sidecar.${provider || "unknown"}`,
    metadata: { sessionId, traceId },
    tracer: trace.getTracer("cognia.sidecar.ai-sdk"),
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
