import assert from "node:assert/strict"
import test from "node:test"
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base"

import { aiSdkTelemetry, initializeTelemetry, shutdownTelemetry } from "./index.ts"
import { sanitizeLangfuseReadableSpan } from "./langfuse.ts"

/** A partial span literal standing in for the SDK's ReadableSpan. */
const span = (value: object): ReadableSpan => value as unknown as ReadableSpan

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
  assert.ok(options)
  // v7 removed both of these from the per-call options: telemetry is on by
  // default once registered, and a custom tracer now belongs to the
  // `OpenTelemetry` instance passed to `registerTelemetry`.
  const raw = options as unknown as Record<string, unknown>
  assert.equal(raw.isEnabled, undefined)
  assert.equal(raw.tracer, undefined)
  // Privacy contract, unchanged across the upgrade: no prompt or completion
  // content may enter a span.
  assert.equal(options.recordInputs, false)
  assert.equal(options.recordOutputs, false)
  assert.equal(options.functionId, "cognia.sidecar.openai")
  assert.equal(raw.metadata, undefined)
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
  assert.equal(options?.recordInputs, false)
  assert.equal(options?.recordOutputs, false)
  await shutdownTelemetry()
})

test("Langfuse-only configuration enables AI SDK content only after explicit consent", async () => {
  const langfuseEnv: Record<string, string | undefined> = {
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
  assert.equal(options?.recordInputs, true)
  assert.equal(options?.recordOutputs, true)

  const model = sanitizeLangfuseReadableSpan(
    span({
      attributes: {
        "langfuse.observation.type": "generation",
        "langfuse.observation.input": "model input",
        "langfuse.observation.output": "model output",
      },
    })
  )
  const tool = sanitizeLangfuseReadableSpan(
    span({
      name: "tool.search",
      status: { code: 2, message: "jane.doe@example.com" },
      events: [{ name: "exception", attributes: { message: "private stack" } }],
      attributes: {
        "langfuse.observation.type": "tool",
        "langfuse.observation.input": "tool input",
        "langfuse.observation.output": "tool output",
      },
    })
  )
  assert.equal(model?.attributes["langfuse.observation.input"], undefined)
  assert.equal(model?.attributes["langfuse.observation.output"], undefined)
  assert.equal(tool?.attributes["langfuse.observation.input"], "tool input")
  assert.equal(tool?.attributes["langfuse.observation.output"], "tool output")
  assert.deepEqual(tool?.status, { code: 2 })
  assert.deepEqual(tool?.events, [])
  await shutdownTelemetry()
})

test("an unconfigured process stays silent", async () => {
  assert.equal(initializeTelemetry({}), false)
  assert.equal(aiSdkTelemetry({ provider: "openai" }), undefined)
  await shutdownTelemetry()
})
