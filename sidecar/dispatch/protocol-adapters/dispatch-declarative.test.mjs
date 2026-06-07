// End-to-end: a turn dispatched with a NON-builtin protocol + declarative
// spec flows through the variant adapter and the event adapter, producing
// the same SDKMessage shapes downstream as the builtin path. Lives in its
// own file so `ai-sdk.test.mjs` (the byte-identical regression canary for
// builtin protocols) stays untouched.

import { test } from "node:test"
import assert from "node:assert/strict"
import { dispatchAiSdk } from "../ai-sdk.mjs"

const SPEC = {
  kind: "openai-compatible-variant",
  urlTemplate: "{baseURL}/v1/chat/completions",
  headers: { Authorization: "Bearer {apiKey}" },
  responsePaths: {
    textDelta: "choices[0].delta.content",
    finishReason: "choices[0].finish_reason",
    usage: { input: "usage.prompt_tokens", output: "usage.completion_tokens" },
  },
}

function fakeFetchSse(lines) {
  const encoder = new TextEncoder()
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => "",
    body: (async function* () {
      for (const line of lines) yield encoder.encode(`${line}\n`)
    })(),
  })
}

function captureEmit() {
  const events = []
  return { events, emit: (msg) => events.push(msg) }
}

function waitForEnd(events) {
  return new Promise((resolve) => {
    const tick = () => {
      if (events.some((e) => e.type === "session_ended")) return resolve()
      setTimeout(tick, 10)
    }
    tick()
  })
}

test("declarative spec drives a full turn end-to-end (assistant text + usage)", async () => {
  const { events, emit } = captureEmit()
  // The variant adapter reads `req.fetchFn` — but dispatchAiSdk doesn't
  // thread a fetch override. Patch globalThis.fetch for the test.
  const originalFetch = globalThis.fetch
  globalThis.fetch = fakeFetchSse([
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Hi" } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: " there" } }] })}`,
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 2 },
    })}`,
    "data: [DONE]",
  ])
  try {
    const session = dispatchAiSdk({
      provider: "acme-custom",
      sessionId: "s1",
      firstPrompt: "hello",
      sendOptions: {
        model: "acme-chat-1",
        providerCredentials: {
          apiKey: "sk-acme",
          baseURL: "https://llm.acme.dev",
          protocol: "acme-plugin:wire",
        },
        protocolAdapterSpec: SPEC,
      },
      emit,
      log: () => {},
    })
    assert.ok(session, "declarative dispatch must start a session")
    await waitForEnd(events)

    const snapshots = events.filter((e) => e.type === "event" && e.event.type === "assistant")
    assert.ok(snapshots.length >= 1)
    assert.equal(snapshots.at(-1).event.message.content[0].text, "Hi there")

    const result = events.find((e) => e.type === "event" && e.event.type === "result")
    assert.ok(result)
    assert.equal(result.event.usage.input_tokens, 11)
    assert.equal(result.event.usage.output_tokens, 2)

    const ended = events.find((e) => e.type === "session_ended")
    assert.equal(ended.error, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("non-builtin protocol WITHOUT a spec still fails with the historical error", () => {
  const { events, emit } = captureEmit()
  const result = dispatchAiSdk({
    provider: "acme-custom",
    sessionId: "s1",
    firstPrompt: "hi",
    sendOptions: {
      model: "m",
      providerCredentials: { apiKey: "k", protocol: "acme-plugin:wire" },
    },
    emit,
    log: () => {},
  })
  assert.equal(result, null)
  const ended = events.find((e) => e.type === "session_ended")
  assert.match(ended.error, /no resolvable AI SDK protocol/)
})

test("upstream HTTP errors surface as session_ended.error with retry hints", async () => {
  const { events, emit } = captureEmit()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 429,
    headers: { get: (k) => (k === "retry-after" ? "30" : null) },
    text: async () => "rate limited",
    body: null,
  })
  try {
    dispatchAiSdk({
      provider: "acme-custom",
      sessionId: "s1",
      firstPrompt: "hi",
      sendOptions: {
        model: "m",
        providerCredentials: { apiKey: "k", baseURL: "https://x", protocol: "p:w" },
        protocolAdapterSpec: SPEC,
      },
      emit,
      log: () => {},
    })
    await waitForEnd(events)
    const ended = events.find((e) => e.type === "session_ended")
    assert.match(ended.error, /HTTP 429/)
    assert.match(ended.error, /retry-after: 30/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
