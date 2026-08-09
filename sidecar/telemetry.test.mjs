import assert from "node:assert/strict"
import test from "node:test"
import { ROOT_CONTEXT, propagation, trace } from "@opentelemetry/api"
import {
  __TESTING__,
  aiSdkTelemetry,
  initializeTelemetry,
  parentContext,
  shutdownTelemetry,
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
