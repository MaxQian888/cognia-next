import assert from "node:assert/strict"
import test from "node:test"
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base"

import { initializeTelemetry, shutdownTelemetry } from "./index.ts"
import { sanitizeLangfuseReadableSpan, sanitizeLangfuseValue } from "./langfuse.ts"

/** A partial span literal standing in for the SDK's ReadableSpan. */
const span = (value: object): ReadableSpan => value as unknown as ReadableSpan

const LANGFUSE_CREDENTIALS = {
  LANGFUSE_PUBLIC_KEY: "pk-test",
  LANGFUSE_SECRET_KEY: "sk-test",
  LANGFUSE_BASE_URL: "https://langfuse.example",
}

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
      ...LANGFUSE_CREDENTIALS,
      COGNIA_LANGFUSE_CAPTURE_MODEL_CONTENT: "true",
      COGNIA_LANGFUSE_CAPTURE_TOOL_CONTENT: "false",
    }),
    true
  )
  const modelOnly = sanitizeLangfuseReadableSpan(
    span({
      name: "llm.generate",
      attributes: {
        "langfuse.observation.type": "generation",
        "gen_ai.system_instructions": "model system",
        "gen_ai.input.messages": messages,
      },
    })
  )
  const modelMessages = String(modelOnly?.attributes["gen_ai.input.messages"])
  assert.match(modelMessages, /hello model/)
  assert.doesNotMatch(modelMessages, /tool query|tool-call|toolName/)
  assert.equal(modelOnly?.attributes["gen_ai.system_instructions"], "model system")
  await shutdownTelemetry()

  assert.equal(
    initializeTelemetry({
      ...LANGFUSE_CREDENTIALS,
      COGNIA_LANGFUSE_CAPTURE_MODEL_CONTENT: "false",
      COGNIA_LANGFUSE_CAPTURE_TOOL_CONTENT: "true",
    }),
    true
  )
  const toolOnly = sanitizeLangfuseReadableSpan(
    span({
      name: "llm.generate",
      attributes: {
        "langfuse.observation.type": "generation",
        "gen_ai.system_instructions": "model system",
        "gen_ai.input.messages": messages,
      },
    })
  )
  const toolMessages = String(toolOnly?.attributes["gen_ai.input.messages"])
  assert.doesNotMatch(toolMessages, /hello model|model reply|model system/)
  assert.match(toolMessages, /tool query|tool-call/)
  assert.equal(toolOnly?.attributes["gen_ai.system_instructions"], undefined)
  await shutdownTelemetry()
})

test("sanitizeLangfuseValue drops PII-bearing strings and keys and bounds the rest", () => {
  assert.equal(sanitizeLangfuseValue("reach me at jane.doe@example.com"), undefined)
  assert.equal(sanitizeLangfuseValue("x".repeat(600)), "x".repeat(512))
  assert.equal(sanitizeLangfuseValue(Number.NaN), undefined)
  assert.deepEqual(sanitizeLangfuseValue({ "jane.doe@example.com": 1, safe: [true, "ok"] }), {
    safe: [true, "ok"],
  })
})
