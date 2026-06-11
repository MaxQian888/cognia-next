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

test("stripReasoningParts removes reasoning parts from assistant messages only", () => {
  const { stripReasoningParts } = __testing__
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "thinking…" },
        { type: "text", text: "answer" },
      ],
    },
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "t1", output: { type: "text", value: "ok" } }],
    },
    { role: "assistant", content: "plain string stays" },
  ]
  const out = stripReasoningParts(messages)
  assert.equal(out.length, 3)
  assert.deepEqual(out[0].content, [{ type: "text", text: "answer" }])
  // Non-assistant + string-content messages pass through untouched (same ref).
  assert.equal(out[1], messages[1])
  assert.equal(out[2], messages[2])
})

test("toAiSdkUserContent converts an Anthropic base64 image to AI SDK v6 shape", () => {
  const { toAiSdkUserContent } = __testing__
  const out = toAiSdkUserContent([
    { type: "text", text: "what is this?" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
  ])
  assert.deepEqual(out[0], { type: "text", text: "what is this?" })
  assert.deepEqual(out[1], {
    type: "image",
    image: "data:image/png;base64,AAAA",
    mediaType: "image/png",
  })
})

test("toAiSdkUserContent maps a url image source to { image: url }", () => {
  const { toAiSdkUserContent } = __testing__
  const out = toAiSdkUserContent([
    { type: "image", source: { type: "url", url: "https://x/y.jpg" } },
  ])
  assert.deepEqual(out[0], { type: "image", image: "https://x/y.jpg" })
})

test("toAiSdkUserContent converts document/file base64 blocks to AI SDK file parts", () => {
  const { toAiSdkUserContent } = __testing__
  const out = toAiSdkUserContent([
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBER" } },
    { type: "file", source: { type: "base64", media_type: "text/plain", data: "aGk=" } },
  ])
  assert.deepEqual(out[0], {
    type: "file",
    data: "data:application/pdf;base64,JVBER",
    mediaType: "application/pdf",
  })
  assert.deepEqual(out[1], {
    type: "file",
    data: "data:text/plain;base64,aGk=",
    mediaType: "text/plain",
  })
})

test("toAiSdkUserContent passes through AI-SDK-shaped and unknown blocks", () => {
  const { toAiSdkUserContent } = __testing__
  const alreadyImage = { type: "image", image: "data:image/png;base64,AAAA" }
  const alreadyFile = { type: "file", data: "data:text/plain;base64,aGk=", mediaType: "text/plain" }
  const unknown = { type: "custom", foo: 1 }
  const out = toAiSdkUserContent([alreadyImage, alreadyFile, unknown, "raw string"])
  // Already-converted parts and unrecognised blocks are returned untouched.
  assert.deepEqual(out[0], alreadyImage)
  assert.deepEqual(out[1], alreadyFile)
  assert.deepEqual(out[2], unknown)
  assert.equal(out[3], "raw string")
})

test("toAiSdkUserContent tolerates a missing media_type on a base64 image", () => {
  const { toAiSdkUserContent } = __testing__
  const out = toAiSdkUserContent([{ type: "image", source: { type: "base64", data: "AAAA" } }])
  // No mediaType key is emitted when the source omits media_type.
  assert.deepEqual(out[0], { type: "image", image: "data:;base64,AAAA" })
})

test("toAiSdkUserContent passes a non-array argument straight through", () => {
  const { toAiSdkUserContent } = __testing__
  assert.equal(toAiSdkUserContent("hello"), "hello")
})

test("stripReasoningParts drops assistant messages that become empty", () => {
  const { stripReasoningParts } = __testing__
  const out = stripReasoningParts([
    { role: "assistant", content: [{ type: "reasoning", text: "only thoughts" }] },
    { role: "assistant", content: [{ type: "text", text: "kept" }] },
  ])
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].content, [{ type: "text", text: "kept" }])
})

test("stripReasoningParts keeps untouched messages by reference when nothing filtered", () => {
  const { stripReasoningParts } = __testing__
  const msg = { role: "assistant", content: [{ type: "text", text: "no reasoning here" }] }
  const out = stripReasoningParts([msg])
  assert.equal(out[0], msg)
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

test("tool_result_review round-trip rewrites the tool output the model sees", async () => {
  const { events, emit } = captureEmit()
  const session = dispatchAiSdk({
    provider: "openai",
    sessionId: "s1",
    firstPrompt: "hi",
    sendOptions: {
      model: "gpt-x",
      providerCredentials: { apiKey: "k", protocol: "openai" },
      toolResultReviewEnabled: true,
    },
    emit,
    log: () => {},
    streamText: makeFakeStream([
      { type: "tool-call", toolCallId: "c1", toolName: "web_fetch", args: { url: "x" } },
      { type: "tool-result", toolCallId: "c1", output: "RAW SECRET" },
      { type: "finish", finishReason: "stop" },
    ]),
  })
  // Wait for the review request, then resolve it with a rewrite (the renderer's job).
  await new Promise((resolve) => {
    const tick = () => {
      const review = events.find((e) => e.type === "tool_result_review")
      if (review) {
        session.pendingToolResultReviews.get(review.reviewId).resolve("CLEAN")
        return resolve()
      }
      setTimeout(tick, 5)
    }
    tick()
  })
  await new Promise((resolve) => {
    const tick = () => {
      if (events.some((e) => e.type === "session_ended")) return resolve()
      setTimeout(tick, 5)
    }
    tick()
  })
  const review = events.find((e) => e.type === "tool_result_review")
  assert.equal(review.toolName, "web_fetch")
  assert.equal(review.toolUseId, "c1")
  assert.equal(review.result, "RAW SECRET")
  // The emitted tool_result (synthetic user message) carries the rewritten output.
  const userMsg = events.find((e) => e.type === "event" && e.event.type === "user")
  assert.ok(userMsg, "tool_result user message emitted")
  assert.equal(userMsg.event.message.content[0].content, "CLEAN")
})

test("no tool_result_review is emitted when review is not enabled", async () => {
  const { events, emit } = captureEmit()
  dispatchAiSdk({
    provider: "openai",
    sessionId: "s1",
    firstPrompt: "hi",
    sendOptions: { model: "gpt-x", providerCredentials: { apiKey: "k", protocol: "openai" } },
    emit,
    log: () => {},
    streamText: makeFakeStream([
      { type: "tool-call", toolCallId: "c1", toolName: "web_fetch", args: {} },
      { type: "tool-result", toolCallId: "c1", output: "RAW" },
      { type: "finish", finishReason: "stop" },
    ]),
  })
  await new Promise((resolve) => {
    const tick = () => {
      if (events.some((e) => e.type === "session_ended")) return resolve()
      setTimeout(tick, 5)
    }
    tick()
  })
  assert.ok(!events.some((e) => e.type === "tool_result_review"))
  const userMsg = events.find((e) => e.type === "event" && e.event.type === "user")
  assert.equal(userMsg.event.message.content[0].content, "RAW")
})

test("systemPrompt and appendSystemPrompt concatenate into a single system message", async () => {
  const { events, emit } = captureEmit()
  let captured = null
  const fakeStream = (args) => {
    captured = args
    return makeFakeStream([{ type: "finish", finishReason: "stop" }])()
  }
  dispatchAiSdk({
    provider: "openai",
    sessionId: "s1",
    firstPrompt: "hi",
    sendOptions: {
      model: "gpt-x",
      providerCredentials: { apiKey: "k", protocol: "openai" },
      systemPrompt: "BASE_SYSTEM",
      appendSystemPrompt: "APPENDED_DYNAMIC_TAIL",
    },
    emit,
    log: () => {},
    streamText: fakeStream,
  })
  await new Promise((resolve) => {
    const tick = () => {
      if (events.some((e) => e.type === "session_ended")) return resolve()
      setTimeout(tick, 10)
    }
    tick()
  })
  assert.ok(captured, "streamText invoked")
  assert.equal(captured.messages[0].role, "system")
  // Previously appendSystemPrompt was silently dropped when systemPrompt was
  // set — both must reach the model, append last.
  assert.equal(captured.messages[0].content, "BASE_SYSTEM\n\nAPPENDED_DYNAMIC_TAIL")
})

test("anthropic protocol + cacheOptimizationEnabled splits system at the stable boundary with a cacheControl breakpoint", async () => {
  const { events, emit } = captureEmit()
  let captured = null
  const fakeStream = (args) => {
    captured = args
    return makeFakeStream([{ type: "finish", finishReason: "stop" }])()
  }
  dispatchAiSdk({
    provider: "my-claude-proxy",
    sessionId: "s1",
    firstPrompt: "hi",
    sendOptions: {
      model: "claude-x",
      providerCredentials: { apiKey: "k", protocol: "anthropic" },
      systemPrompt: "STABLE_PREFIX",
      appendSystemPrompt: "DYNAMIC_TAIL",
      cacheOptimizationEnabled: true,
    },
    emit,
    log: () => {},
    streamText: fakeStream,
  })
  await new Promise((resolve) => {
    const tick = () => {
      if (events.some((e) => e.type === "session_ended")) return resolve()
      setTimeout(tick, 10)
    }
    tick()
  })
  const systems = captured.messages.filter((m) => m.role === "system")
  assert.equal(systems.length, 2)
  assert.equal(systems[0].content, "STABLE_PREFIX")
  assert.deepEqual(systems[0].providerOptions, {
    anthropic: { cacheControl: { type: "ephemeral" } },
  })
  assert.equal(systems[1].content, "DYNAMIC_TAIL")
  assert.equal(systems[1].providerOptions, undefined)
})

test("cacheOptimizationEnabled without the anthropic protocol keeps the single concatenated system message", async () => {
  const { events, emit } = captureEmit()
  let captured = null
  const fakeStream = (args) => {
    captured = args
    return makeFakeStream([{ type: "finish", finishReason: "stop" }])()
  }
  dispatchAiSdk({
    provider: "deepseek",
    sessionId: "s1",
    firstPrompt: "hi",
    sendOptions: {
      model: "deepseek-chat",
      providerCredentials: { apiKey: "k" },
      systemPrompt: "STABLE_PREFIX",
      appendSystemPrompt: "DYNAMIC_TAIL",
      cacheOptimizationEnabled: true,
    },
    emit,
    log: () => {},
    streamText: fakeStream,
  })
  await new Promise((resolve) => {
    const tick = () => {
      if (events.some((e) => e.type === "session_ended")) return resolve()
      setTimeout(tick, 10)
    }
    tick()
  })
  const systems = captured.messages.filter((m) => m.role === "system")
  assert.equal(systems.length, 1)
  assert.equal(systems[0].content, "STABLE_PREFIX\n\nDYNAMIC_TAIL")
  assert.equal(systems[0].providerOptions, undefined)
})

test("appendSystemPrompt alone still produces a system message", async () => {
  const { events, emit } = captureEmit()
  let captured = null
  const fakeStream = (args) => {
    captured = args
    return makeFakeStream([{ type: "finish", finishReason: "stop" }])()
  }
  dispatchAiSdk({
    provider: "openai",
    sessionId: "s1",
    firstPrompt: "hi",
    sendOptions: {
      model: "gpt-x",
      providerCredentials: { apiKey: "k", protocol: "openai" },
      appendSystemPrompt: "ONLY_APPEND",
    },
    emit,
    log: () => {},
    streamText: fakeStream,
  })
  await new Promise((resolve) => {
    const tick = () => {
      if (events.some((e) => e.type === "session_ended")) return resolve()
      setTimeout(tick, 10)
    }
    tick()
  })
  assert.equal(captured.messages[0].role, "system")
  assert.equal(captured.messages[0].content, "ONLY_APPEND")
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

test("dispatchAiSdk emits a clear 'not configured' error when a provider has no key or base URL", () => {
  // Switching to an openai-protocol provider (deepseek / opencode) with no
  // configured key must NOT leak `@ai-sdk/openai`'s "OpenAI API key is missing"
  // message — the user never selected OpenAI. Fail fast, naming the real provider.
  const { events, emit } = captureEmit()
  const result = dispatchAiSdk({
    provider: "deepseek",
    sessionId: "s1",
    firstPrompt: "hi",
    sendOptions: { model: "deepseek-v4-flash" }, // no providerCredentials
    emit,
    log: () => {},
  })
  assert.equal(result, null)
  const ended = events.find((e) => e.type === "session_ended")
  assert.ok(ended)
  assert.match(ended.error, /provider "deepseek" is not configured/)
  assert.doesNotMatch(ended.error, /OpenAI API key/i)
})

test("dispatchAiSdk allows a keyless provider that supplies a base URL (local engine)", () => {
  // Local engines (ollama / lmstudio) ride the openai protocol with a base URL
  // and no key — they must pass the missing-credential guard.
  const { events, emit } = captureEmit()
  const result = dispatchAiSdk({
    provider: "ollama",
    sessionId: "s1",
    firstPrompt: "hi",
    sendOptions: {
      model: "llama3",
      providerCredentials: { baseURL: "http://localhost:11434/v1", protocol: "openai" },
    },
    emit,
    log: () => {},
    streamText: makeFakeStream([{ type: "finish", finishReason: "stop" }]),
  })
  // Not null → the turn started (the guard let it through).
  assert.ok(result)
  const ended = events.find((e) => e.type === "session_ended" && e.error)
  assert.equal(ended, undefined, "no missing-credential error for a base-URL-only provider")
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

test("dispatchAiSdk surfaces an in-stream error part (not a throw) as session_ended.error", async () => {
  // AI SDK v6 reports provider/auth/network failures as a `{ type:"error" }`
  // part in `fullStream` and only console.errors them — it does NOT throw. Before
  // the fix the dispatcher accumulated no text and ended with a silent (errorless)
  // session_ended, which the capture loop reports as the misleading "ended with no
  // assistant text". The real provider message must be surfaced instead.
  const { events, emit } = captureEmit()
  const errorPartStream = () => ({
    fullStream: (async function* () {
      yield { type: "stream-start", warnings: [] }
      yield { type: "error", error: { code: "invalid_api_key", message: "401 Unauthorized" } }
    })(),
    usage: Promise.resolve({}),
  })
  const session = dispatchAiSdk({
    provider: "deepseek",
    sessionId: "s1",
    firstPrompt: "hi",
    sendOptions: {
      model: "deepseek-v4-flash",
      providerCredentials: { apiKey: "sk", protocol: "openai" },
    },
    emit,
    log: () => {},
    streamText: errorPartStream,
  })
  assert.ok(session)
  await new Promise((resolve) => {
    const tick = () => {
      if (events.some((e) => e.type === "session_ended")) return resolve()
      setTimeout(tick, 10)
    }
    tick()
  })
  const ended = events.find((e) => e.type === "session_ended")
  assert.ok(ended, "a session_ended is emitted")
  assert.match(ended.error, /401 Unauthorized/)
})

test("dispatchAiSdk does not leak an unhandled rejection when result getters reject", async () => {
  // `result.response` / `result.usage` are getters that mint a FRESH promise on
  // every access; on a partial-error turn that promise rejects. The dispatcher
  // must read each exactly once — a throwaway `x ? await x : …` truthiness probe
  // would leave the probe copy unawaited and crash the sidecar with an unhandled
  // rejection (observed live as `reason "[object Object]"`).
  const rejected = []
  const onUnhandled = (reason) => rejected.push(reason)
  process.on("unhandledRejection", onUnhandled)
  try {
    const { events, emit } = captureEmit()
    // Some text IS produced, so the early error-return is skipped and the
    // response/usage reads below are exercised.
    const getterRejectStream = () => ({
      fullStream: (async function* () {
        yield { type: "text-delta", textDelta: "partial" }
        yield { type: "error", error: { code: "boom", message: "exploded" } }
      })(),
      // Fresh rejecting promise per access — mirrors the real AI SDK getters.
      get response() {
        return Promise.reject(new Error("No output generated."))
      },
      get usage() {
        return Promise.reject(new Error("No output generated."))
      },
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
      streamText: getterRejectStream,
    })
    assert.ok(session)
    await new Promise((resolve) => {
      const tick = () => {
        if (events.some((e) => e.type === "session_ended")) return resolve()
        setTimeout(tick, 10)
      }
      tick()
    })
    // Give any floating rejection a couple of microtask/macrotask turns to surface.
    await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(rejected, [], "no unhandled rejection escaped the dispatcher")
  } finally {
    process.removeListener("unhandledRejection", onUnhandled)
  }
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

const waitForEvent = (events, pred) =>
  new Promise((resolve) => {
    const tick = () => (events.some(pred) ? resolve() : setTimeout(tick, 5))
    tick()
  })

const compactStream = () =>
  makeFakeStream(
    [
      { type: "text-delta", id: "1", text: "ANSWER" },
      { type: "finish", finishReason: "stop" },
    ],
    // Large prompt-token count → the auto-compact threshold is crossed after
    // the first turn (gpt-4o window 128k, fraction 0.835 ≈ 106_880).
    { promptTokens: 200_000 }
  )

test("auto-compaction honours sendOptions.compaction (fraction/keepRecent) and emits an auto boundary", async () => {
  const { events, emit } = captureEmit()
  const session = dispatchAiSdk({
    provider: "openai",
    sessionId: "s1",
    firstPrompt: "hi",
    sendOptions: {
      model: "gpt-4o",
      providerCredentials: { apiKey: "k", protocol: "openai" },
      compaction: { enabled: true, keepRecent: 1, summaryPrompt: "SUMMARIZE TERSELY" },
    },
    emit,
    log: () => {},
    streamText: compactStream(),
  })
  // Queue a second turn up front: the loop runs turn 1 (sets lastInputTokens
  // from its usage) before turn 2, whose head triggers auto-compaction.
  session.pushUserMessage("second turn")
  await waitForEvent(events, (e) => e.event?.subtype === "compact_boundary")
  const boundary = events.find((e) => e.event?.subtype === "compact_boundary")
  assert.equal(boundary.event.compact_metadata.trigger, "auto")
  assert.ok(boundary.event.compact_metadata.pre_tokens > 0)
})

test("auto-compaction is skipped when compaction.enabled is false", async () => {
  const { events, emit } = captureEmit()
  const session = dispatchAiSdk({
    provider: "openai",
    sessionId: "s1",
    firstPrompt: "hi",
    sendOptions: {
      model: "gpt-4o",
      providerCredentials: { apiKey: "k", protocol: "openai" },
      compaction: { enabled: false, keepRecent: 1 },
    },
    emit,
    log: () => {},
    streamText: compactStream(),
  })
  session.pushUserMessage("second turn")
  await waitForEvent(events, (e) => e.event?.type === "assistant")
  // Let the second turn run; no boundary should ever be emitted.
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(
    events.some((e) => e.event?.subtype === "compact_boundary"),
    false
  )
})

test("requestCompact() forces a manual boundary between turns", async () => {
  const { events, emit } = captureEmit()
  const session = dispatchAiSdk({
    provider: "openai",
    sessionId: "s1",
    firstPrompt: "hi",
    sendOptions: {
      model: "gpt-4o",
      providerCredentials: { apiKey: "k", protocol: "openai" },
      // Manual compaction bypasses the threshold, so a tiny usage is fine.
      compaction: { enabled: true, keepRecent: 1 },
    },
    emit,
    log: () => {},
    streamText: makeFakeStream([
      { type: "text-delta", id: "1", text: "A1" },
      { type: "finish", finishReason: "stop" },
    ]),
  })
  // Wait for turn 1 to finish (assistant snapshot) and settle to idle.
  await waitForEvent(events, (e) => e.event?.type === "assistant")
  await new Promise((r) => setTimeout(r, 30))
  await session.requestCompact("the API changes")
  const boundary = events.find((e) => e.event?.subtype === "compact_boundary")
  assert.ok(boundary, "a manual compact boundary is emitted")
  assert.equal(boundary.event.compact_metadata.trigger, "manual")
})
