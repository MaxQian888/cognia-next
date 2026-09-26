import assert from "node:assert/strict"
import test from "node:test"
import type { Span } from "@opentelemetry/sdk-trace-base"

import { CogniaCorrelationSpanProcessor } from "./correlation.ts"
import { initializeTelemetry, shutdownTelemetry } from "./index.ts"

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
  const attributes: Record<string, unknown> = {
    "langfuse.observation.metadata.cogniaSessionId": "session-1",
    "langfuse.observation.metadata.cogniaTraceId": "a".repeat(32),
    "langfuse.observation.metadata.cogniaSurface": "chat",
    "langfuse.observation.metadata.cogniaRunId": "run-1",
    "langfuse.observation.metadata.cogniaTurnId": "turn-1",
    "langfuse.observation.metadata.cogniaAttemptId": "attempt-1",
    "langfuse.observation.metadata.cogniaProjectId": "project-1",
  }
  const processor = new CogniaCorrelationSpanProcessor()
  processor.onStart({
    attributes,
    setAttribute(key: string, value: unknown) {
      attributes[key] = value
    },
  } as unknown as Span)

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
