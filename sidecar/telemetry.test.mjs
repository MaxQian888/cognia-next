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

test("rejects Personal API Keys and non-HTTP PostHog destinations", () => {
  assert.deepEqual(
    __TESTING__.parsePostHogDestinations(
      JSON.stringify([
        { id: "byo", host: "https://posthog.example", projectToken: "phx_personal" },
        { id: "byo", host: "https://posthog.example", projectToken: "phc_" },
        { id: "byo", host: "https://posthog.example", projectToken: "phc_bad token" },
        { id: "byo", host: "file:///tmp/posthog", projectToken: "phc_project" },
      ])
    ),
    []
  )
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
    surface: "chat",
    runId: "run-1",
    turnId: "turn-1",
    attemptId: "attempt-1",
    projectId: "project-1",
    feature: "chat",
    promptComponentIds: ["system.base", "mode.agent"],
    promptVersion: "7",
    promptFingerprint: "sha256:abc",
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
  assert.equal(options.metadata, undefined)
  assert.deepEqual(options.runtimeContext, {
    cogniaSessionId: "session-1",
    cogniaTraceId: "a".repeat(32),
    cogniaSurface: "chat",
    cogniaRunId: "run-1",
    cogniaTurnId: "turn-1",
    cogniaAttemptId: "attempt-1",
    cogniaProjectId: "project-1",
    cogniaFeature: "chat",
    cogniaPromptComponentIds: ["system.base", "mode.agent"],
    cogniaPromptVersion: "7",
    cogniaPromptFingerprint: "sha256:abc",
  })
  assert.deepEqual(options.includeRuntimeContext, {
    cogniaSessionId: true,
    cogniaTraceId: true,
    cogniaSurface: true,
    cogniaRunId: true,
    cogniaTurnId: true,
    cogniaAttemptId: true,
    cogniaProjectId: true,
    cogniaFeature: true,
    cogniaPromptComponentIds: true,
    cogniaPromptVersion: true,
    cogniaPromptFingerprint: true,
  })

  // A second init must not register the integration again — `registerTelemetry`
  // appends to a process-global list, so a duplicate would double every span.
  assert.equal(
    initializeTelemetry({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces" }),
    false
  )
  await shutdownTelemetry()
})

test("PostHog-only configuration initializes telemetry without a generic OTLP endpoint", async () => {
  assert.equal(
    initializeTelemetry({
      COGNIA_POSTHOG_DESTINATIONS_JSON: JSON.stringify([
        {
          id: "managed",
          host: "https://us.i.posthog.com",
          projectToken: "phc_test",
        },
      ]),
      COGNIA_OBSERVABILITY_INSTALLATION_ID: "installation-1",
    }),
    true
  )
  const options = aiSdkTelemetry({ sessionId: "session-2", provider: "anthropic" })
  assert.equal(options.recordInputs, false)
  assert.equal(options.recordOutputs, false)
  await shutdownTelemetry()
})

test("Langfuse-only configuration enables AI SDK content only after explicit consent", async () => {
  const langfuseEnv = {
    LANGFUSE_PUBLIC_KEY: "pk-test",
    LANGFUSE_SECRET_KEY: "sk-test",
    LANGFUSE_BASE_URL: "https://langfuse.example",
    LANGFUSE_ENVIRONMENT: "test",
    COGNIA_LANGFUSE_CAPTURE_MODEL_CONTENT: "false",
    COGNIA_LANGFUSE_CAPTURE_TOOL_CONTENT: "true",
  }
  assert.equal(initializeTelemetry(langfuseEnv), true)
  assert.equal(langfuseEnv.LANGFUSE_SECRET_KEY, undefined)
  const options = aiSdkTelemetry({ sessionId: "session-3", provider: "openai" })
  assert.equal(options.recordInputs, true)
  assert.equal(options.recordOutputs, true)

  const model = __TESTING__.sanitizeLangfuseReadableSpan({
    attributes: {
      "langfuse.observation.type": "generation",
      "langfuse.observation.input": "model input",
      "langfuse.observation.output": "model output",
    },
  })
  const tool = __TESTING__.sanitizeLangfuseReadableSpan({
    name: "tool.search",
    status: { code: 2, message: "jane.doe@example.com" },
    events: [{ name: "exception", attributes: { message: "private stack" } }],
    attributes: {
      "langfuse.observation.type": "tool",
      "langfuse.observation.input": "tool input",
      "langfuse.observation.output": "tool output",
    },
  })
  assert.equal(model.attributes["langfuse.observation.input"], undefined)
  assert.equal(model.attributes["langfuse.observation.output"], undefined)
  assert.equal(tool.attributes["langfuse.observation.input"], "tool input")
  assert.equal(tool.attributes["langfuse.observation.output"], "tool output")
  assert.deepEqual(tool.status, { code: 2 })
  assert.deepEqual(tool.events, [])
  await shutdownTelemetry()
})

test("Langfuse model and tool message consent remain independent", async () => {
  const messages = JSON.stringify([
    { role: "user", content: [{ type: "text", text: "hello model" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "model reply" },
        { type: "tool-call", toolName: "lookup", arguments: { query: "tool query" } },
      ],
    },
  ])
  assert.equal(
    initializeTelemetry({
      LANGFUSE_PUBLIC_KEY: "pk-test",
      LANGFUSE_SECRET_KEY: "sk-test",
      LANGFUSE_BASE_URL: "https://langfuse.example",
      COGNIA_LANGFUSE_CAPTURE_MODEL_CONTENT: "true",
      COGNIA_LANGFUSE_CAPTURE_TOOL_CONTENT: "false",
    }),
    true
  )
  const modelOnly = __TESTING__.sanitizeLangfuseReadableSpan({
    name: "llm.generate",
    attributes: {
      "langfuse.observation.type": "generation",
      "gen_ai.system_instructions": "model system",
      "gen_ai.input.messages": messages,
    },
  })
  const modelMessages = modelOnly.attributes["gen_ai.input.messages"]
  assert.match(modelMessages, /hello model/)
  assert.doesNotMatch(modelMessages, /tool query|tool-call|toolName/)
  assert.equal(modelOnly.attributes["gen_ai.system_instructions"], "model system")
  await shutdownTelemetry()

  assert.equal(
    initializeTelemetry({
      LANGFUSE_PUBLIC_KEY: "pk-test",
      LANGFUSE_SECRET_KEY: "sk-test",
      LANGFUSE_BASE_URL: "https://langfuse.example",
      COGNIA_LANGFUSE_CAPTURE_MODEL_CONTENT: "false",
      COGNIA_LANGFUSE_CAPTURE_TOOL_CONTENT: "true",
    }),
    true
  )
  const toolOnly = __TESTING__.sanitizeLangfuseReadableSpan({
    name: "llm.generate",
    attributes: {
      "langfuse.observation.type": "generation",
      "gen_ai.system_instructions": "model system",
      "gen_ai.input.messages": messages,
    },
  })
  const toolMessages = toolOnly.attributes["gen_ai.input.messages"]
  assert.doesNotMatch(toolMessages, /hello model|model reply|model system/)
  assert.match(toolMessages, /tool query|tool-call/)
  assert.equal(toolOnly.attributes["gen_ai.system_instructions"], undefined)
  await shutdownTelemetry()
})

test("preserves Cognia and PostHog correlation across the Langfuse AI SDK integration", async () => {
  assert.equal(
    initializeTelemetry({
      COGNIA_POSTHOG_DESTINATIONS_JSON: JSON.stringify([
        {
          id: "managed",
          host: "https://us.i.posthog.com",
          projectToken: "phc_test",
        },
      ]),
      COGNIA_OBSERVABILITY_INSTALLATION_ID: "installation-1",
    }),
    true
  )
  const attributes = {
    "langfuse.observation.metadata.cogniaSessionId": "session-1",
    "langfuse.observation.metadata.cogniaTraceId": "a".repeat(32),
    "langfuse.observation.metadata.cogniaSurface": "chat",
    "langfuse.observation.metadata.cogniaRunId": "run-1",
    "langfuse.observation.metadata.cogniaTurnId": "turn-1",
    "langfuse.observation.metadata.cogniaAttemptId": "attempt-1",
    "langfuse.observation.metadata.cogniaProjectId": "project-1",
  }
  const processor = new __TESTING__.CogniaCorrelationSpanProcessor()
  processor.onStart({
    attributes,
    setAttribute(key, value) {
      attributes[key] = value
    },
  })

  assert.equal(attributes["gen_ai.conversation.id"], "session-1")
  assert.equal(attributes["cognia.trace_id"], "a".repeat(32))
  assert.equal(attributes["cognia.surface"], "chat")
  assert.equal(attributes["cognia.run.id"], "run-1")
  assert.equal(attributes["cognia.turn.id"], "turn-1")
  assert.equal(attributes["cognia.attempt.id"], "attempt-1")
  assert.equal(attributes["cognia.project.id"], "project-1")
  assert.equal(attributes["posthog.distinct_id"], "installation-1")

  await processor.forceFlush()
  await processor.shutdown()
  await shutdownTelemetry()
})

test("remote span filtering removes content, tool arguments, files, URLs, and exception text", () => {
  const sanitized = __TESTING__.sanitizeReadableSpan({
    spanContext() {
      return { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 }
    },
    attributes: {
      "gen_ai.request.model": "gpt-5",
      "gen_ai.input.messages": "private prompt",
      "tool.arguments": "private tool args",
      "cognia.file.path": "/private/file.txt",
      "http.url": "https://private.example/path",
      "exception.message": "private exception",
    },
    status: { code: 2, message: "private failure" },
    resource: {
      attributes: {
        "service.name": "cognia-sidecar",
        "process.command": "/Users/private/bin/node",
      },
    },
    events: [
      {
        name: "generation.status",
        attributes: { "exception.stacktrace": "private stack", "cognia.span.status": "failed" },
      },
    ],
  })
  const payload = JSON.stringify(sanitized)
  assert.equal(payload.includes("private"), false)
  assert.equal(sanitized.attributes["gen_ai.request.model"], "gpt-5")
  assert.equal(sanitized.events[0].attributes["cognia.span.status"], "failed")
  assert.deepEqual(sanitized.status, { code: 2 })
  assert.deepEqual(sanitized.resource.attributes, { "service.name": "cognia-sidecar" })
  assert.equal(sanitized.spanContext().traceId, "a".repeat(32))
})

test("remote span filtering drops a sanitized span when an allowed value still contains PII", () => {
  let delegated = false
  let result
  const exporter = new __TESTING__.PrivacyFilteringSpanExporter({
    export() {
      delegated = true
    },
    shutdown: async () => undefined,
  })
  exporter.export(
    [
      {
        name: "chat jane.doe@example.com",
        attributes: { "gen_ai.request.model": "model@example.com" },
        events: [],
      },
    ],
    (value) => {
      result = value
    }
  )

  assert.equal(delegated, false)
  assert.deepEqual(result, { code: 0 })
})

test("remote span filtering forwards safe spans and removes only unsafe members of a batch", () => {
  let delegatedSpans = []
  const exporter = new __TESTING__.PrivacyFilteringSpanExporter({
    export(spans, callback) {
      delegatedSpans = spans
      callback({ code: 0 })
    },
    shutdown: async () => undefined,
  })
  exporter.export(
    [
      {
        name: "chat jane.doe@example.com",
        attributes: { "gen_ai.request.model": "model@example.com" },
        events: [],
      },
      {
        name: "chat gpt-5",
        attributes: { "gen_ai.request.model": "gpt-5" },
        events: [],
      },
    ],
    () => undefined
  )

  assert.equal(delegatedSpans.length, 1)
  assert.equal(delegatedSpans[0].name, "chat gpt-5")
})

test("privacy filtering exporter forwards lifecycle calls when supported", async () => {
  let shutdownCalls = 0
  let flushCalls = 0
  const exporter = new __TESTING__.PrivacyFilteringSpanExporter({
    export() {},
    shutdown: async () => {
      shutdownCalls += 1
    },
    forceFlush: async () => {
      flushCalls += 1
    },
  })

  await exporter.forceFlush()
  await exporter.shutdown()

  assert.equal(flushCalls, 1)
  assert.equal(shutdownCalls, 1)

  const exporterWithoutFlush = new __TESTING__.PrivacyFilteringSpanExporter({
    export() {},
    shutdown: async () => undefined,
  })
  await exporterWithoutFlush.forceFlush()
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
