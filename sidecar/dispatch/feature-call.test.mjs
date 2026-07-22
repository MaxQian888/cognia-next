import test from "node:test"
import assert from "node:assert/strict"

import { createFeatureCallHandler } from "./feature-call.mjs"

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("correlates concurrent generate calls and emits usage", async () => {
  const events = []
  const first = deferred()
  const second = deferred()
  const models = new Map([
    ["m1", { doGenerate: () => first.promise }],
    ["m2", { doGenerate: () => second.promise }],
  ])
  const handler = createFeatureCallHandler({
    emit: (event) => events.push(event),
    buildModel: async ({ model }) => models.get(model),
  })

  const a = handler.call({
    type: "feature_call",
    requestId: "a",
    operation: "language-generate",
    model: "m1",
    credentials: { secretAccessKey: "never-emit" },
    options: {},
  })
  const b = handler.call({
    type: "feature_call",
    requestId: "b",
    operation: "language-generate",
    model: "m2",
    credentials: {},
    options: {},
  })
  second.resolve({
    content: [],
    finishReason: "stop",
    usage: { inputTokens: 2, outputTokens: 3 },
    warnings: [],
  })
  first.resolve({
    content: [],
    finishReason: "stop",
    usage: { inputTokens: 5, outputTokens: 8 },
    warnings: [],
  })
  await Promise.all([a, b])

  assert.deepEqual(events.map((event) => event.requestId).sort(), ["a", "b"])
  assert.equal(
    events.every((event) => event.type === "feature_call_result"),
    true
  )
  assert.equal(JSON.stringify(events).includes("never-emit"), false)
})

test("streams model events and a terminal completion", async () => {
  const events = []
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "text-start", id: "1" })
      controller.enqueue({ type: "text-delta", id: "1", delta: "hello" })
      controller.close()
    },
  })
  const handler = createFeatureCallHandler({
    emit: (event) => events.push(event),
    buildModel: async () => ({ doStream: async () => ({ stream }) }),
  })

  await handler.call({
    type: "feature_call",
    requestId: "stream-1",
    operation: "language-stream",
    model: "m",
    credentials: {},
    options: {},
  })

  assert.deepEqual(events, [
    { type: "feature_call_stream", requestId: "stream-1", part: { type: "text-start", id: "1" } },
    {
      type: "feature_call_stream",
      requestId: "stream-1",
      part: { type: "text-delta", id: "1", delta: "hello" },
    },
    { type: "feature_call_stream_end", requestId: "stream-1" },
  ])
})

test("abort cancels the correlated request without affecting another call", async () => {
  const events = []
  const handler = createFeatureCallHandler({
    emit: (event) => events.push(event),
    buildModel: async ({ model }) => ({
      doGenerate: ({ abortSignal }) =>
        model === "fast"
          ? Promise.resolve({ content: [], finishReason: "stop", usage: {}, warnings: [] })
          : new Promise((_, reject) => {
              abortSignal.addEventListener("abort", () => reject(abortSignal.reason), {
                once: true,
              })
            }),
    }),
  })
  const slow = handler.call({
    type: "feature_call",
    requestId: "slow",
    operation: "language-generate",
    model: "slow",
    credentials: {},
    options: {},
  })
  const fast = handler.call({
    type: "feature_call",
    requestId: "fast",
    operation: "language-generate",
    model: "fast",
    credentials: {},
    options: {},
  })
  assert.equal(handler.abort("slow"), true)
  await Promise.all([slow, fast])

  assert.equal(
    events.some((event) => event.type === "feature_call_aborted" && event.requestId === "slow"),
    true
  )
  assert.equal(
    events.some((event) => event.type === "feature_call_result" && event.requestId === "fast"),
    true
  )
})

test("credential-chain failures are actionable and scrub configured secrets", async () => {
  const events = []
  const handler = createFeatureCallHandler({
    emit: (event) => events.push(event),
    buildModel: async () => {
      throw new Error("failed for secret-value")
    },
  })
  await handler.call({
    type: "feature_call",
    requestId: "fail",
    operation: "language-generate",
    model: "m",
    credentials: { secretAccessKey: "secret-value" },
    options: {},
  })

  assert.deepEqual(events, [
    {
      type: "feature_call_error",
      requestId: "fail",
      error: "failed for [REDACTED]",
    },
  ])
})

test("executes Bedrock embeddings through the correlated feature channel", async () => {
  const events = []
  const handler = createFeatureCallHandler({
    emit: (event) => events.push(event),
    buildEmbeddingModel: async () => ({
      doEmbed: async ({ values }) => ({
        embeddings: values.map(() => ({ values: [0.1, 0.2] })),
        warnings: [],
      }),
    }),
  })
  await handler.call({
    type: "feature_call",
    requestId: "embed-1",
    operation: "embedding",
    model: "amazon.titan-embed-text-v2:0",
    credentials: { bedrockAuthMode: "default-chain", region: "us-east-1" },
    options: { values: ["safe text"] },
  })
  assert.deepEqual(events, [
    {
      type: "feature_call_result",
      requestId: "embed-1",
      result: { embeddings: [{ values: [0.1, 0.2] }], warnings: [] },
    },
  ])
})
