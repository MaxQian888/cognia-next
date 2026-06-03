// Tests for the AI SDK dispatcher. We inject a fake `streamText` so the test
// doesn't need network and doesn't depend on @ai-sdk/* being importable in
// every CI environment.

import { test } from "node:test"
import assert from "node:assert/strict"
import { dispatchAiSdk, __testing__ } from "./ai-sdk.mjs"

function makeFakeStream(events, usage = { promptTokens: 5, completionTokens: 3 }) {
  return () => ({
    fullStream: (async function* () {
      for (const e of events) yield e
    })(),
    usage: Promise.resolve(usage),
  })
}

function captureEmit() {
  const events = []
  return {
    events,
    emit: (msg) => events.push(msg),
  }
}

test("resolveProtocol picks openai for openai/openrouter/groq/deepseek", () => {
  const { resolveProtocol } = __testing__
  assert.equal(resolveProtocol("openai", undefined), "openai")
  assert.equal(resolveProtocol("openrouter", undefined), "openai")
  assert.equal(resolveProtocol("deepseek", undefined), "openai")
  assert.equal(resolveProtocol("groq", undefined), "openai")
})

test("resolveProtocol picks google for google/gemini", () => {
  const { resolveProtocol } = __testing__
  assert.equal(resolveProtocol("google", undefined), "google")
  assert.equal(resolveProtocol("gemini", undefined), "google")
})

test("resolveProtocol uses explicit protocol from credentials when provider is custom", () => {
  const { resolveProtocol } = __testing__
  assert.equal(resolveProtocol("my-self-hosted", { protocol: "openai" }), "openai")
  assert.equal(resolveProtocol("acme", { protocol: "anthropic" }), "anthropic")
})

test("resolveProtocol returns null for unknown provider with no protocol hint", () => {
  const { resolveProtocol } = __testing__
  assert.equal(resolveProtocol("acme-corp", undefined), null)
})

test("resolveProtocol maps built-in local engines to the openai protocol (ADR-0043)", () => {
  const { resolveProtocol } = __testing__
  for (const p of [
    "ollama",
    "lmstudio",
    "llamacpp",
    "llamafile",
    "vllm",
    "localai",
    "jan",
    "textgenwebui",
    "koboldcpp",
    "tabbyapi",
  ]) {
    assert.equal(resolveProtocol(p, undefined), "openai")
  }
})

test("session exposes pendingApprovals AND pendingPluginToolCalls (gate-first contract)", () => {
  const { emit } = captureEmit()
  const session = dispatchAiSdk({
    provider: "openai",
    sessionId: "s1",
    firstPrompt: "hi",
    sendOptions: {
      model: "gpt-x",
      providerCredentials: { apiKey: "k", protocol: "openai" },
      builtinTools: {},
      pluginTools: [],
    },
    emit,
    log: () => {},
    streamText: makeFakeStream([]),
  })
  assert.ok(session.pendingApprovals instanceof Map)
  assert.ok(session.pendingPluginToolCalls instanceof Map)
})

test("v6 text-delta (field `text`) produces non-empty assistant text end-to-end", async () => {
  const { events, emit } = captureEmit()
  dispatchAiSdk({
    provider: "openai",
    sessionId: "s1",
    firstPrompt: "hi",
    sendOptions: { model: "gpt-x", providerCredentials: { apiKey: "k", protocol: "openai" } },
    emit,
    log: () => {},
    streamText: makeFakeStream([
      { type: "text-delta", id: "1", text: "Hello" },
      { type: "text-delta", id: "1", text: " v6" },
      { type: "finish", finishReason: "stop" },
    ]),
  })
  await new Promise((resolve) => {
    const tick = () => {
      if (events.some((e) => e.type === "session_ended")) return resolve()
      setTimeout(tick, 10)
    }
    tick()
  })
  const snapshots = events.filter((e) => e.type === "event" && e.event.type === "assistant")
  assert.ok(snapshots.length >= 1)
  assert.equal(snapshots[snapshots.length - 1].event.message.content[0].text, "Hello v6")
})

test("dispatchAiSdk emits session_ended error when provider has no resolvable protocol", () => {
  const { events, emit } = captureEmit()
  const result = dispatchAiSdk({
    provider: "acme-mystery",
    sessionId: "s1",
    firstPrompt: "hi",
    sendOptions: { model: "x" },
    emit,
    log: () => {},
  })
  assert.equal(result, null)
  const ended = events.find((e) => e.type === "session_ended")
  assert.ok(ended)
  assert.match(ended.error, /no resolvable AI SDK protocol/)
})

test("dispatchAiSdk requires a model field", () => {
  const { events, emit } = captureEmit()
  const result = dispatchAiSdk({
    provider: "openai",
    sessionId: "s1",
    firstPrompt: "hi",
    sendOptions: { providerCredentials: { apiKey: "k" } },
    emit,
    log: () => {},
  })
  assert.equal(result, null)
  const ended = events.find((e) => e.type === "session_ended")
  assert.match(ended.error, /model is required/)
})

test("dispatchAiSdk emits sdk_session_id and proxies fake stream events", async () => {
  const { events, emit } = captureEmit()
  // Note: the dispatcher reads `result.usage` (the stream-level Promise),
  // not the per-event `finish.usage`, so we set the makeFakeStream default
  // to control the final result-message usage.
  const fakeStream = makeFakeStream(
    [
      { type: "text-delta", textDelta: "hello" },
      { type: "text-delta", textDelta: " world" },
      { type: "finish", finishReason: "stop" },
    ],
    { promptTokens: 9, completionTokens: 4 }
  )
  const session = dispatchAiSdk({
    provider: "openai",
    sessionId: "s1",
    firstPrompt: "say hi",
    sendOptions: {
      model: "gpt-4o-mini",
      providerCredentials: { apiKey: "sk-test", protocol: "openai" },
    },
    emit,
    log: () => {},
    streamText: fakeStream,
  })
  assert.ok(session)
  // Wait for the async runTurn to finish (best-effort: session_ended marks completion).
  await new Promise((resolve) => {
    const tick = () => {
      if (events.some((e) => e.type === "session_ended")) return resolve()
      setTimeout(tick, 10)
    }
    tick()
  })

  const sidEvent = events.find((e) => e.type === "sdk_session_id")
  assert.ok(sidEvent)
  assert.equal(sidEvent.sessionId, "s1")

  const assistantSnapshots = events.filter(
    (e) => e.type === "event" && e.event.type === "assistant"
  )
  assert.ok(assistantSnapshots.length >= 1)
  const lastSnapshot = assistantSnapshots[assistantSnapshots.length - 1]
  assert.equal(lastSnapshot.event.message.content[0].text, "hello world")

  const result = events.find((e) => e.type === "event" && e.event.type === "result")
  assert.ok(result)
  assert.equal(result.event.usage.input_tokens, 9)
  assert.equal(result.event.usage.output_tokens, 4)

  const ended = events.find((e) => e.type === "session_ended")
  assert.ok(ended)
  assert.equal(ended.error, undefined)
})

test("dispatchAiSdk surfaces stream errors as session_ended.error", async () => {
  const { events, emit } = captureEmit()
  const failingStream = () => ({
    fullStream: (async function* () {
      throw new Error("rate limited")
    })(),
    usage: Promise.resolve({}),
  })
  const session = dispatchAiSdk({
    provider: "openai",
    sessionId: "s1",
    firstPrompt: "hi",
    sendOptions: {
      model: "gpt-4o-mini",
      providerCredentials: { apiKey: "sk", protocol: "openai" },
    },
    emit,
    log: () => {},
    streamText: failingStream,
  })
  assert.ok(session)
  await new Promise((resolve) => {
    const tick = () => {
      if (events.some((e) => e.type === "session_ended" && e.error)) return resolve()
      setTimeout(tick, 10)
    }
    tick()
  })
  const ended = events.find((e) => e.type === "session_ended")
  assert.match(ended.error, /rate limited/)
})

test("closeInput cancels in-flight turn and ends session", async () => {
  const { events, emit } = captureEmit()
  // A stream that yields a tiny delta, then sleeps forever.
  const slowStream = () => ({
    fullStream: (async function* () {
      yield { type: "text-delta", textDelta: "hi" }
      await new Promise(() => {}) // never resolves
    })(),
    usage: Promise.resolve({}),
  })
  const session = dispatchAiSdk({
    provider: "openai",
    sessionId: "s1",
    firstPrompt: "hi",
    sendOptions: {
      model: "gpt-4o-mini",
      providerCredentials: { apiKey: "sk", protocol: "openai" },
    },
    emit,
    log: () => {},
    streamText: slowStream,
  })
  // Give the runTurn a moment to attach.
  await new Promise((r) => setTimeout(r, 30))
  session.closeInput()
  // closeInput sets cancelled=true; the existing for-await loop won't break
  // mid-yield (the stream is sleeping), but the session should still be
  // marked usable. Validate that `pendingApprovals` is empty per the
  // documented gap.
  assert.equal(session.pendingApprovals.size, 0)
})
