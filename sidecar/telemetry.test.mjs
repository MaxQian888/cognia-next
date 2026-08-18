import assert from "node:assert/strict"
import test from "node:test"
import { ROOT_CONTEXT, propagation, trace } from "@opentelemetry/api"
import {
  __TESTING__,
  aiSdkTelemetry,
  initializeTelemetry,
  parentContext,
  shutdownTelemetry,
  traceAsyncIterable,
  withTraceparent,
} from "./telemetry.mjs"

test("parses OTLP headers without putting them on argv", () => {
  assert.deepEqual(__TESTING__.parseHeaders("Authorization=Basic abc==, x-tenant = one"), {
    Authorization: "Basic abc==",
    "x-tenant": "one",
  })
  assert.deepEqual(__TESTING__.parseHeaders("ignored=x", '{"authorization":"Basic abc=="}'), {
    authorization: "Basic abc==",
  })
})

test("extracts a valid W3C traceparent and makes it current", () => {
  propagation.setGlobalPropagator({
    inject() {},
    fields: () => ["traceparent"],
    extract(carrierContext, carrier) {
      const [, traceId, spanId] = carrier.traceparent.split("-")
      return trace.setSpanContext(carrierContext, { traceId, spanId, traceFlags: 1 })
    },
  })
  const value = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"
  assert.equal(trace.getSpanContext(parentContext(value)).traceId, value.split("-")[1])
  let callbackRan = false
  withTraceparent(value, () => {
    callbackRan = true
  })
  assert.equal(callbackRan, true)
  propagation.disable()
  assert.equal(parentContext(undefined), ROOT_CONTEXT)
})

test("AI SDK telemetry is enabled only after configuration and never records content", async () => {
  // No OTLP endpoint configured → no telemetry options are ever attached to a
  // call. This is what keeps an unconfigured sidecar completely silent: AI SDK 7
  // telemetry is opt-OUT once an integration is registered, so registration is
  // deliberately tied to `initializeTelemetry` succeeding.
  assert.equal(aiSdkTelemetry({ provider: "openai" }), undefined)
  assert.equal(
    initializeTelemetry({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
      OTEL_SERVICE_NAME: "test-sidecar",
    }),
    true
  )
  const options = aiSdkTelemetry({
    sessionId: "session-1",
    traceId: "a".repeat(32),
    provider: "openai",
  })
  // v7 removed both of these from the per-call options: telemetry is on by
  // default once registered, and a custom tracer now belongs to the
  // `OpenTelemetry` instance passed to `registerTelemetry`.
  assert.equal(options.isEnabled, undefined)
  assert.equal(options.tracer, undefined)
  // Privacy contract, unchanged across the upgrade: no prompt or completion
  // content may enter a span.
  assert.equal(options.recordInputs, false)
  assert.equal(options.recordOutputs, false)
  assert.equal(options.functionId, "cognia.sidecar.openai")
  assert.deepEqual(options.metadata, { sessionId: "session-1", traceId: "a".repeat(32) })

  // A second init must not register the integration again — `registerTelemetry`
  // appends to a process-global list, so a duplicate would double every span.
  assert.equal(
    initializeTelemetry({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces" }),
    false
  )
  await shutdownTelemetry()
})

// ---- local span repatriation ---------------------------------------------
// The sidecar used to emit spans ONLY through OTLP, so a default install (no
// collector configured) recorded nothing for the out-of-process half of a turn.

async function drain(iterable) {
  const seen = []
  for await (const item of iterable) seen.push(item)
  return seen
}

test("stays a plain pass-through when neither an exporter nor an emitter exists", async () => {
  const source = (async function* () {
    yield 1
  })()
  // Identity, not a wrapper: no proxy on the hot path when nothing consumes it.
  assert.equal(traceAsyncIterable("n", undefined, {}, source), source)
})

test("repatriates a finished span to the emitter with no OTLP endpoint", async () => {
  const emitted = []
  const source = (async function* () {
    yield "a"
    yield "b"
  })()
  const wrapped = traceAsyncIterable(
    "gen_ai.invoke_agent",
    "00-" + "a".repeat(32) + "-" + "b".repeat(16) + "-01",
    { "gen_ai.request.model": "claude-opus-5" },
    source,
    { emit: (event) => emitted.push(event), sessionId: "session-1" }
  )
  assert.deepEqual(await drain(wrapped), ["a", "b"])
  assert.equal(emitted.length, 1)
  const span = emitted[0]
  assert.equal(span.type, "agent_trace_span")
  assert.equal(span.sessionId, "session-1")
  assert.equal(span.operationName, "invoke_agent")
  assert.equal(span.providerName, "anthropic")
  // The traceparent is echoed back verbatim so the renderer — which owns the
  // W3C parser — reattaches the span under the turn that spawned it.
  assert.equal(span.traceparent, "00-" + "a".repeat(32) + "-" + "b".repeat(16) + "-01")
  assert.match(span.spanId, /^[0-9a-f]{16}$/)
  assert.equal(typeof span.startTime, "number")
  assert.ok(span.durationMs >= 0)
  assert.deepEqual(span.attributes, { "gen_ai.request.model": "claude-opus-5" })
  assert.equal(span.errorType, undefined)
})

test("repatriates a failed stream with its error and emits exactly once", async () => {
  const emitted = []
  const source = (async function* () {
    yield "a"
    throw new TypeError("stream died")
  })()
  const wrapped = traceAsyncIterable("gen_ai.invoke_agent", undefined, {}, source, {
    emit: (event) => emitted.push(event),
  })
  await assert.rejects(() => drain(wrapped), /stream died/)
  // `finish` runs from both the catch and the finally — the span must not double.
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].errorType, "TypeError")
  assert.equal(emitted[0].errorMessage, "stream died")
})

test("mints a distinct span id per wrapped stream", () => {
  const ids = new Set()
  for (let i = 0; i < 50; i++) ids.add(__TESTING__.randomSpanId())
  assert.equal(ids.size, 50)
  for (const id of ids) assert.match(id, /^[0-9a-f]{16}$/)
})

test("a throwing emitter never breaks the stream it measures", async () => {
  const source = (async function* () {
    yield "a"
  })()
  const wrapped = traceAsyncIterable("n", undefined, {}, source, {
    emit: () => {
      throw new Error("host channel closed")
    },
  })
  assert.deepEqual(await drain(wrapped), ["a"])
})

test("forwards non-iterator properties to the wrapped query object", async () => {
  let reconnected = null
  const source = {
    reconnectMcpServer(name) {
      reconnected = name
      return "ok"
    },
    async *[Symbol.asyncIterator]() {
      yield "a"
    },
  }
  const wrapped = traceAsyncIterable("n", undefined, {}, source, { emit: () => {} })
  // The SDK's query object carries control methods the dispatcher calls.
  assert.equal(wrapped.reconnectMcpServer("lark"), "ok")
  assert.equal(reconnected, "lark")
  assert.deepEqual(await drain(wrapped), ["a"])
})
