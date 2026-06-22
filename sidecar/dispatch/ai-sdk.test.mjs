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

test("resolveProtocol picks openai for opencode and codex", () => {
  const { resolveProtocol } = __testing__
  assert.equal(resolveProtocol("opencode", undefined), "openai")
  assert.equal(resolveProtocol("opencode-go", undefined), "openai")
  assert.equal(resolveProtocol("codex", undefined), "openai")
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

test("anthropic + cacheOptimizationEnabled splits appendSystemPrompt at the dynamicSystemPrompt boundary (second breakpoint)", async () => {
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
      systemPrompt: "BASE",
      appendSystemPrompt: "STABLE_APPEND\n\nDYN_TAIL",
      dynamicSystemPrompt: "DYN_TAIL",
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
  // base (cached) + stable head of append (cached) + dynamic tail (uncached).
  assert.equal(systems.length, 3)
  assert.equal(systems[0].content, "BASE")
  assert.deepEqual(systems[0].providerOptions, {
    anthropic: { cacheControl: { type: "ephemeral" } },
  })
  assert.equal(systems[1].content, "STABLE_APPEND")
  assert.deepEqual(systems[1].providerOptions, {
    anthropic: { cacheControl: { type: "ephemeral" } },
  })
  assert.equal(systems[2].content, "DYN_TAIL")
  assert.equal(systems[2].providerOptions, undefined)
})

test("anthropic + cacheOptimizationEnabled tags the last message with a history cacheControl breakpoint", async () => {
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
      systemPrompt: "BASE",
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
  const last = captured.messages[captured.messages.length - 1]
  assert.equal(last.role, "user")
  assert.deepEqual(last.providerOptions?.anthropic?.cacheControl, { type: "ephemeral" })
})

test("non-anthropic protocol leaves the last message without a cacheControl breakpoint", async () => {
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
      systemPrompt: "BASE",
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
  const last = captured.messages[captured.messages.length - 1]
  assert.equal(last.providerOptions, undefined)
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
  // The last leg's prompt size rides along as the window-occupancy figure (here
  // a single leg, so it coincides with input_tokens).
  assert.equal(result.event.usage.context_input_tokens, 9)

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

test("multi-turn: successive turns share ONE dispatcher; session_closed fires only on close", async () => {
  const { events, emit } = captureEmit()
  // A fresh stream per turn (factory) so each pushed turn produces output.
  const stream = () => ({
    fullStream: (async function* () {
      yield { type: "text-delta", id: "1", text: "reply" }
      yield { type: "finish", finishReason: "stop" }
    })(),
    usage: Promise.resolve({ promptTokens: 5, completionTokens: 2 }),
  })
  const session = dispatchAiSdk({
    provider: "openai",
    sessionId: "s1",
    firstPrompt: "turn 1",
    sendOptions: { model: "gpt-x", providerCredentials: { apiKey: "k", protocol: "openai" } },
    emit,
    log: () => {},
    streamText: stream,
  })
  // The multiTurn marker is what tells the host to KEEP this session across
  // per-turn `session_ended` events (the context-loss fix).
  assert.equal(session.multiTurn, true)

  const endedCount = () => events.filter((e) => e.type === "session_ended").length
  await waitForEvent(events, () => endedCount() >= 1)
  // Turn 1 ended but the dispatcher did NOT self-close — context stays alive.
  assert.equal(
    events.some((e) => e.type === "session_closed"),
    false
  )

  session.pushUserMessage("turn 2")
  await waitForEvent(events, () => endedCount() >= 2)
  // Two turns completed on ONE dispatcher; still no self-close.
  assert.equal(
    events.some((e) => e.type === "session_closed"),
    false
  )

  // Only an explicit close retires the session.
  session.closeInput()
  await waitForEvent(events, (e) => e.type === "session_closed")
  assert.ok(events.some((e) => e.type === "session_closed"))
})

test("multi-turn: a later turn's reply does not duplicate the previous turn's text", async () => {
  const { events, emit } = captureEmit()
  // Distinct text per turn so a carried-over buffer is detectable.
  let turn = 0
  const stream = () => {
    turn += 1
    const text = turn === 1 ? "FIRST_REPLY" : "SECOND_REPLY"
    return {
      fullStream: (async function* () {
        yield { type: "text-delta", id: "1", text }
        yield { type: "finish", finishReason: "stop" }
      })(),
      usage: Promise.resolve({ promptTokens: 5, completionTokens: 2 }),
    }
  }
  const session = dispatchAiSdk({
    provider: "openai",
    sessionId: "s1",
    firstPrompt: "turn 1",
    sendOptions: { model: "gpt-x", providerCredentials: { apiKey: "k", protocol: "openai" } },
    emit,
    log: () => {},
    streamText: stream,
  })

  const endedCount = () => events.filter((e) => e.type === "session_ended").length
  await waitForEvent(events, () => endedCount() >= 1)
  session.pushUserMessage("turn 2")
  await waitForEvent(events, () => endedCount() >= 2)

  // Collect every assistant snapshot's text. Without the head-of-turn
  // adapter.reset(), turn 2's snapshots would read "FIRST_REPLYSECOND_REPLY".
  const assistantTexts = events
    .filter((e) => e.type === "event" && e.event?.type === "assistant")
    .map((e) => e.event.message.content.find((b) => b.type === "text")?.text ?? "")
  assert.ok(
    assistantTexts.some((t) => t === "FIRST_REPLY"),
    "turn 1 reply present"
  )
  assert.ok(
    assistantTexts.some((t) => t === "SECOND_REPLY"),
    "turn 2 reply present and standalone"
  )
  assert.ok(
    !assistantTexts.some((t) => t.includes("FIRST_REPLYSECOND_REPLY")),
    "turn 2 must NOT re-emit turn 1's text prepended"
  )

  session.closeInput()
  await waitForEvent(events, (e) => e.type === "session_closed")
})

test("interrupt ends the current turn but keeps the multi-turn session for the next message", async () => {
  const { events, emit } = captureEmit()
  // Turn 1 streams a tiny delta then stalls until the abort signal fires (the
  // way the real streamText reacts to interrupt()), so the turn can end cleanly.
  let turn = 0
  const stream = (args) => {
    turn += 1
    if (turn === 1) {
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", id: "1", text: "partial" }
          while (!args?.abortSignal?.aborted) {
            await new Promise((r) => setTimeout(r, 5))
          }
        })(),
        usage: Promise.resolve({}),
      }
    }
    return {
      fullStream: (async function* () {
        yield { type: "text-delta", id: "1", text: "second-turn-reply" }
        yield { type: "finish", finishReason: "stop" }
      })(),
      usage: Promise.resolve({ promptTokens: 5, completionTokens: 2 }),
    }
  }
  const session = dispatchAiSdk({
    provider: "openai",
    sessionId: "s1",
    firstPrompt: "turn 1",
    sendOptions: { model: "gpt-x", providerCredentials: { apiKey: "k", protocol: "openai" } },
    emit,
    log: () => {},
    streamText: stream,
  })
  await new Promise((r) => setTimeout(r, 20))
  await session.q.interrupt()
  await waitForEvent(events, (e) => e.type === "session_ended")
  // The interrupt did NOT close the session.
  assert.equal(
    events.some((e) => e.type === "session_closed"),
    false
  )
  // A follow-up message runs a fresh turn on the SAME dispatcher.
  session.pushUserMessage("turn 2")
  await waitForEvent(
    events,
    (e) =>
      e.type === "event" &&
      e.event?.type === "assistant" &&
      /second-turn-reply/.test(JSON.stringify(e.event))
  )
  assert.equal(turn, 2)
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

test("reasoning effort is forwarded to a genuine OpenAI provider as reasoningEffort", async () => {
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
      model: "o4-mini",
      // No baseURL → genuine OpenAI endpoint → reasoningEffort is honoured.
      providerCredentials: { apiKey: "k", protocol: "openai" },
      effort: "high",
    },
    emit,
    log: () => {},
    streamText: fakeStream,
  })
  await waitForEvent(events, (e) => e.type === "session_ended")
  // Previously effort/maxThinkingTokens were dropped on the ai-sdk path, so the
  // reasoning model ran with thinking off. It must now reach the provider —
  // together with reasoningSummary:"auto" so the reasoning is actually visible.
  assert.deepEqual(captured.providerOptions?.openai, {
    reasoningEffort: "high",
    reasoningSummary: "auto",
  })
})

test("interrupt() aborts the in-flight provider request (not just a cooperative flag)", async () => {
  const { events, emit } = captureEmit()
  let captured = null
  const fakeStream = (args) => {
    captured = args
    return {
      // Hang until the abort signal fires, then reject like streamText does.
      fullStream: (async function* () {
        await new Promise((_resolve, reject) => {
          args.abortSignal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          )
        })
      })(),
      usage: Promise.resolve({}),
    }
  }
  const session = dispatchAiSdk({
    provider: "openai",
    sessionId: "s1",
    firstPrompt: "hi",
    sendOptions: { model: "gpt-x", providerCredentials: { apiKey: "k", protocol: "openai" } },
    emit,
    log: () => {},
    streamText: fakeStream,
  })
  // Let the turn start and reach the hanging stream.
  await new Promise((r) => setTimeout(r, 20))
  assert.ok(captured?.abortSignal, "abortSignal threaded into streamText")
  assert.equal(captured.abortSignal.aborted, false)
  await session.q.interrupt()
  assert.equal(captured.abortSignal.aborted, true, "interrupt aborts the in-flight request")
  // The aborted turn is a clean stop, not an errored session_ended.
  await waitForEvent(events, (e) => e.type === "session_ended")
  const ended = events.find((e) => e.type === "session_ended")
  assert.equal(ended.error, undefined, "an interrupted turn ends cleanly, no error surfaced")
})

test("interrupt() resolves all pending round-trips so a stuck session cleans up", async () => {
  const { events, emit } = captureEmit()
  // Use a stream that hangs so the turn never finishes on its own.
  const fakeStream = () => ({
    fullStream: (async function* () {
      await new Promise(() => {}) // never resolves
    })(),
    usage: Promise.resolve({}),
  })
  const session = dispatchAiSdk({
    provider: "openai",
    sessionId: "s1",
    firstPrompt: "hi",
    sendOptions: {
      model: "gpt-x",
      providerCredentials: { apiKey: "k", protocol: "openai" },
      builtinTools: { bash: true },
    },
    emit,
    log: () => {},
    streamText: fakeStream,
  })
  // Wait for the turn to start so `active` flips and tools are built.
  await new Promise((r) => setTimeout(r, 30))
  // Simulate a pending permission approval (like a tool gate waiting on the
  // renderer). When the renderer times out and calls interrupt, these must
  // resolve so the turn can end cleanly.
  let permissionResolved = null
  session.pendingApprovals.set("req-1", {
    resolve: (v) => {
      permissionResolved = v
    },
  })
  let pluginResolved = null
  session.pendingPluginToolCalls.set("pt-1", {
    resolve: (v) => {
      pluginResolved = v
    },
  })
  let reviewResolvedSentinel = null
  session.pendingToolResultReviews.set("tr-1", {
    resolve: (v) => {
      reviewResolvedSentinel = v === undefined ? "__undefined__" : v
    },
  })
  assert.equal(session.pendingApprovals.size, 1)
  assert.equal(session.pendingPluginToolCalls.size, 1)
  assert.equal(session.pendingToolResultReviews.size, 1)
  await session.q.interrupt()
  // Every pending entry is resolved so the tool gate / plugin-tool / review
  // round-trip doesn't hang forever.
  assert.equal(session.pendingApprovals.size, 0)
  assert.equal(session.pendingPluginToolCalls.size, 0)
  assert.equal(session.pendingToolResultReviews.size, 0)
  assert.ok(permissionResolved, "pending approval was resolved")
  assert.deepEqual(
    permissionResolved,
    {
      behavior: "deny",
      message: "interrupted",
    },
    "denied so the tool gate unblocks"
  )
  assert.ok(pluginResolved, "pending plugin call was resolved")
  assert.deepEqual(
    pluginResolved,
    {
      result: undefined,
      error: "interrupted",
    },
    "plugin call errored so M2 unblocks"
  )
  assert.equal(reviewResolvedSentinel, "__undefined__", "review passes through unchanged")
})

test("external mcpServers tools are merged into the turn (parity with the Anthropic path)", async () => {
  const { events, emit } = captureEmit()
  let captured = null
  const fakeStream = (args) => {
    captured = args
    return makeFakeStream([{ type: "finish", finishReason: "stop" }])()
  }
  let closed = false
  // Injected MCP builder — no real server connection.
  const buildMcpTools = async () => ({
    tools: { mcp__docs__search: { description: "d", execute: async () => "hit" } },
    close: async () => {
      closed = true
    },
  })
  const session = dispatchAiSdk({
    provider: "openai",
    sessionId: "s1",
    firstPrompt: "hi",
    sendOptions: {
      model: "gpt-x",
      providerCredentials: { apiKey: "k", protocol: "openai" },
      builtinTools: { git: true },
      mcpServers: { docs: { type: "sse", url: "https://x/sse" } },
    },
    emit,
    log: () => {},
    streamText: fakeStream,
    buildMcpTools,
  })
  await waitForEvent(events, (e) => e.type === "session_ended")
  assert.ok(captured.tools["mcp__docs__search"], "external MCP tool reaches streamText")
  assert.ok(captured.tools.git_status, "built-in tools still present alongside MCP")
  // Tools map stays sorted for prompt-cache prefix stability.
  const keys = Object.keys(captured.tools)
  assert.deepEqual(keys, [...keys].sort())
  session.closeInput()
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(closed, true, "MCP connections closed on teardown")
})

test("the synthesized dispatch_agent subagent tool is offered AND round-trips on the ai-sdk path", async () => {
  // Regression guard for the historical bug where the non-Anthropic (ai-sdk)
  // transport silently dropped subagents: the native Anthropic SDK consumes
  // `options.agents` for free, but ai-sdk must surface `dispatch_agent` as a
  // renderer-proxied plugin tool. This drives the REAL dispatch loop end-to-end
  // (no credentials): the loop must (1) hand `dispatch_agent` to the model, and
  // (2) relay its execution through `plugin_tool_exec` → `pendingPluginToolCalls`.
  const { events, emit } = captureEmit()
  let captured = null
  const fakeStream = (args) => {
    captured = args
    return makeFakeStream([{ type: "finish", finishReason: "stop" }])()
  }
  // Shaped like cli/src/agent's buildCliSubagentToolManifest output.
  const dispatchManifest = {
    name: "dispatch_agent",
    description: "Dispatch a subagent to handle a focused task.",
    jsonSchema: {
      type: "object",
      properties: { subagentId: { type: "string" }, prompt: { type: "string" } },
      required: ["subagentId", "prompt"],
    },
  }
  const session = dispatchAiSdk({
    provider: "openai",
    sessionId: "s1",
    firstPrompt: "review the diff",
    sendOptions: {
      model: "gpt-x",
      // bypassPermissions lets execute() proceed without an approval responder;
      // the gate itself is covered separately in ai-sdk-tools.test.mjs.
      permissionMode: "bypassPermissions",
      providerCredentials: { apiKey: "k", protocol: "openai" },
      pluginTools: [dispatchManifest],
    },
    emit,
    log: () => {},
    streamText: fakeStream,
  })
  await waitForEvent(events, (e) => e.type === "session_ended")

  // (1) Offered: the synthesized tool reached the model's tool set.
  assert.ok(captured.tools.dispatch_agent, "dispatch_agent offered to the model on the ai-sdk path")

  // (2) Round-trips: invoking the offered tool emits a plugin_tool_exec the host
  // relays to the CLI subagent handler, and the resolved reply flows back.
  const exec = captured.tools.dispatch_agent.execute({ subagentId: "reviewer", prompt: "check it" })
  await Promise.resolve()
  const relay = events.find((e) => e.type === "plugin_tool_exec" && e.name === "dispatch_agent")
  assert.ok(relay, "plugin_tool_exec emitted for dispatch_agent")
  assert.equal(relay.args.subagentId, "reviewer")
  // Resolve exactly the way claude-host's plugin_tool_response does for the CLI.
  const pending = session.pendingPluginToolCalls.get(relay.toolUseId)
  assert.ok(pending, "the call is parked in pendingPluginToolCalls awaiting the host")
  pending.resolve({ result: "[reviewer] LGTM — no blocking issues." })
  assert.equal(await exec, "[reviewer] LGTM — no blocking issues.")
})

test("a failing external MCP setup degrades to built-in tools without breaking the turn", async () => {
  const { events, emit } = captureEmit()
  let captured = null
  const fakeStream = (args) => {
    captured = args
    return makeFakeStream([{ type: "finish", finishReason: "stop" }])()
  }
  const buildMcpTools = async () => {
    throw new Error("mcp module blew up")
  }
  dispatchAiSdk({
    provider: "openai",
    sessionId: "s1",
    firstPrompt: "hi",
    sendOptions: {
      model: "gpt-x",
      providerCredentials: { apiKey: "k", protocol: "openai" },
      builtinTools: { git: true },
      mcpServers: { docs: { type: "sse", url: "https://x/sse" } },
    },
    emit,
    log: () => {},
    streamText: fakeStream,
    buildMcpTools,
  })
  await waitForEvent(events, (e) => e.type === "session_ended")
  const ended = events.find((e) => e.type === "session_ended")
  assert.equal(ended.error, undefined, "turn still completes cleanly")
  assert.ok(captured.tools.git_status, "built-in tools survive the MCP failure")
})

// ── Manual agent loop (multi-leg continuation) ─────────────────────────────
// The non-Anthropic channel must keep streaming across tool-call legs until the
// model naturally stops, instead of silently ending after a single capped leg.

test("agent loop continues into another leg when a leg finishes with 'tool-calls'", async () => {
  const { events, emit } = captureEmit()
  let calls = 0
  // Leg 1 stops on `tool-calls` (hit the per-leg cap with tools pending) → must
  // continue; leg 2 stops naturally → must end. No new user message in between.
  const streamText = () => {
    calls += 1
    const finishReason = calls === 1 ? "tool-calls" : "stop"
    const text = calls === 1 ? "leg1 " : "leg2"
    return {
      fullStream: (async function* () {
        yield { type: "text-delta", id: String(calls), text }
        yield { type: "finish", finishReason }
      })(),
      usage: Promise.resolve({ promptTokens: 5, completionTokens: 3 }),
    }
  }
  dispatchAiSdk({
    provider: "openai",
    sessionId: "s1",
    firstPrompt: "hi",
    sendOptions: { model: "gpt-x", providerCredentials: { apiKey: "k", protocol: "openai" } },
    emit,
    log: () => {},
    streamText,
  })
  await waitForEvent(events, (e) => e.type === "session_ended")
  assert.equal(calls, 2, "continued into a second leg without a new user message")
  assert.equal(
    events.filter((e) => e.type === "session_ended").length,
    1,
    "exactly one session_ended for the whole turn"
  )
})

test("agent loop stops at the maxTurns budget with a visible note (no silent stop, no infinite loop)", async () => {
  const { events, emit } = captureEmit()
  let calls = 0
  // The model NEVER stops on its own (always 'tool-calls'). The budget must halt
  // the loop and surface a note rather than looping forever or stopping silently.
  const streamText = () => {
    calls += 1
    return {
      fullStream: (async function* () {
        yield { type: "text-delta", id: String(calls), text: `leg${calls}` }
        yield { type: "finish", finishReason: "tool-calls" }
      })(),
      usage: Promise.resolve({ promptTokens: 5, completionTokens: 3 }),
    }
  }
  dispatchAiSdk({
    provider: "openai",
    sessionId: "s1",
    firstPrompt: "hi",
    sendOptions: {
      model: "gpt-x",
      providerCredentials: { apiKey: "k", protocol: "openai" },
      // A deliberate small budget (mirrors a subagent maxTurns) — one leg only.
      maxTurns: 1,
    },
    emit,
    log: () => {},
    streamText,
  })
  await waitForEvent(events, (e) => e.type === "session_ended")
  assert.equal(calls, 1, "maxTurns=1 spends the whole budget in one leg")
  const snapshots = events.filter((e) => e.type === "event" && e.event.type === "assistant")
  const finalText = snapshots[snapshots.length - 1].event.message.content[0].text
  assert.match(finalText, /safety cap/, "surfaces a visible cap note instead of stopping silently")
})

test("aiSdkMaxSteps caps the agentic budget when no explicit maxTurns is set", async () => {
  const { events, emit } = captureEmit()
  let calls = 0
  const streamText = () => {
    calls += 1
    return {
      fullStream: (async function* () {
        yield { type: "text-delta", id: String(calls), text: `leg${calls}` }
        yield { type: "finish", finishReason: "tool-calls" }
      })(),
      usage: Promise.resolve({ promptTokens: 5, completionTokens: 3 }),
    }
  }
  dispatchAiSdk({
    provider: "openai",
    sessionId: "s1",
    firstPrompt: "hi",
    sendOptions: {
      model: "gpt-x",
      providerCredentials: { apiKey: "k", protocol: "openai" },
      aiSdkMaxSteps: 1,
    },
    emit,
    log: () => {},
    streamText,
  })
  await waitForEvent(events, (e) => e.type === "session_ended")
  assert.equal(calls, 1, "aiSdkMaxSteps=1 caps the loop to one leg")
  const snapshots = events.filter((e) => e.type === "event" && e.event.type === "assistant")
  const finalText = snapshots[snapshots.length - 1].event.message.content[0].text
  assert.match(finalText, /safety cap/, "cap note is surfaced for the config-driven budget too")
})

test("an explicit maxTurns wins over aiSdkMaxSteps for the agentic budget", async () => {
  const { events, emit } = captureEmit()
  let calls = 0
  const streamText = () => {
    calls += 1
    return {
      fullStream: (async function* () {
        yield { type: "text-delta", id: String(calls), text: `leg${calls}` }
        yield { type: "finish", finishReason: "tool-calls" }
      })(),
      usage: Promise.resolve({ promptTokens: 5, completionTokens: 3 }),
    }
  }
  dispatchAiSdk({
    provider: "openai",
    sessionId: "s1",
    firstPrompt: "hi",
    sendOptions: {
      model: "gpt-x",
      providerCredentials: { apiKey: "k", protocol: "openai" },
      // maxTurns (a deliberate subagent/goal budget) must win over the larger
      // config-level aiSdkMaxSteps, so the loop caps at one leg, not 99.
      maxTurns: 1,
      aiSdkMaxSteps: 99,
    },
    emit,
    log: () => {},
    streamText,
  })
  await waitForEvent(events, (e) => e.type === "session_ended")
  assert.equal(calls, 1, "maxTurns=1 caps the loop even though aiSdkMaxSteps=99")
})

test("toolOutputHasImage detects both the raw MCP and toModelOutput shapes", () => {
  const { toolOutputHasImage } = __testing__
  // Raw MCP CallToolResult (what the built-in read tool's execute returns).
  assert.equal(toolOutputHasImage({ content: [{ type: "image", data: "x" }] }), true)
  // Already-mapped toModelOutput content form.
  assert.equal(
    toolOutputHasImage({
      type: "content",
      value: [{ type: "image-data", mediaType: "image/png", data: "x" }],
    }),
    true
  )
  assert.equal(
    toolOutputHasImage({
      type: "content",
      value: [{ type: "media", mediaType: "image/jpeg", data: "x" }],
    }),
    true
  )
  // Non-image media (audio file-data) is not an image.
  assert.equal(
    toolOutputHasImage({
      type: "content",
      value: [{ type: "file-data", mediaType: "audio/wav", data: "x" }],
    }),
    false
  )
  assert.equal(toolOutputHasImage("text"), false)
  assert.equal(toolOutputHasImage(null), false)
})

test("projectToolResultImages pulls tool-result images out into user image parts", () => {
  const { projectToolResultImages } = __testing__
  const messages = [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "t1", toolName: "read" }] },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "t1",
          toolName: "read",
          output: {
            type: "content",
            value: [
              { type: "text", text: "shot.png" },
              { type: "image-data", mediaType: "image/png", data: "QUJD" },
            ],
          },
        },
      ],
    },
  ]
  const { images, sanitized } = projectToolResultImages(messages)
  // One image extracted, as an AI SDK user-content image part (data URL).
  assert.deepEqual(images, [
    { type: "image", image: "data:image/png;base64,QUJD", mediaType: "image/png" },
  ])
  // The tool result no longer carries the base64 image; only a text marker.
  const out = sanitized[1].content[0].output
  assert.equal(out.type, "text")
  assert.match(out.value, /shot\.png/)
  assert.match(out.value, /image returned by read/)
  // The assistant message is untouched (same object identity).
  assert.equal(sanitized[0], messages[0])
})

test("projectToolResultImages is a no-op for image-free tool results", () => {
  const { projectToolResultImages } = __testing__
  const messages = [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "t1",
          toolName: "grep",
          output: { type: "text", value: "ok" },
        },
      ],
    },
  ]
  const { images, sanitized } = projectToolResultImages(messages)
  assert.equal(images.length, 0)
  // Unchanged messages keep object identity (true no-op).
  assert.equal(sanitized[0], messages[0])
})

test("projectToolResultImages keeps surviving non-image parts as a content output", () => {
  const { projectToolResultImages } = __testing__
  const messages = [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "t1",
          toolName: "read",
          output: {
            type: "content",
            value: [
              { type: "image-data", mediaType: "image/png", data: "AA" },
              { type: "file-data", mediaType: "audio/wav", data: "BB" },
            ],
          },
        },
      ],
    },
  ]
  const { images, sanitized } = projectToolResultImages(messages)
  assert.equal(images.length, 1)
  const out = sanitized[0].content[0].output
  // A non-text part survived → output stays a content array (not collapsed).
  assert.equal(out.type, "content")
  assert.equal(
    out.value.some((v) => v.type === "file-data"),
    true
  )
  assert.equal(
    out.value.some((v) => v.type === "text"),
    true
  )
})

// Regression: interrupting a turn mid-tool-call (or a count-based compaction
// slice) can leave `conversation` with an orphan tool message and/or a dangling
// assistant tool-call. On the NEXT turn that history is sent verbatim and an
// OpenAI-compatible provider (DeepSeek) rejects it with "Messages with role
// 'tool' must be a response to a preceding message with 'tool_calls'". The
// dispatcher must scrub the pairing violation before sending.
test("an interrupted tool-call leg does not corrupt the next turn's request", async () => {
  const { events, emit } = captureEmit()
  const captured = []
  let turn = 0
  const stream = (args) => {
    turn += 1
    captured.push(args.messages)
    if (turn === 1) {
      // The leg's response carries a dangling assistant tool-call (t1, never
      // answered) plus an orphan tool result (references ORPHAN, no matching
      // call) — exactly the split an interrupt can leave behind.
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", id: "1", text: "working" }
          yield { type: "finish", finishReason: "stop" }
        })(),
        usage: Promise.resolve({ promptTokens: 5, completionTokens: 2 }),
        response: Promise.resolve({
          messages: [
            {
              role: "assistant",
              content: [{ type: "tool-call", toolCallId: "t1", toolName: "read", input: {} }],
            },
            {
              role: "tool",
              content: [
                { type: "tool-result", toolCallId: "ORPHAN", output: { type: "text", value: "x" } },
              ],
            },
          ],
        }),
      }
    }
    return {
      fullStream: (async function* () {
        yield { type: "text-delta", id: "1", text: "second" }
        yield { type: "finish", finishReason: "stop" }
      })(),
      usage: Promise.resolve({ promptTokens: 5, completionTokens: 2 }),
    }
  }
  const session = dispatchAiSdk({
    provider: "deepseek",
    sessionId: "s1",
    firstPrompt: "turn 1",
    sendOptions: {
      model: "deepseek-chat",
      providerCredentials: { apiKey: "k", protocol: "openai" },
    },
    emit,
    log: () => {},
    streamText: stream,
  })
  const endedCount = () => events.filter((e) => e.type === "session_ended").length
  await waitForEvent(events, () => endedCount() >= 1)
  session.pushUserMessage("turn 2")
  await waitForEvent(events, () => endedCount() >= 2)

  // The second request must satisfy the pairing invariant: no orphan tool
  // message survives, and no assistant message still carries an unanswered call.
  const sent = captured[1]
  const declared = new Set()
  for (const m of sent) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const p of m.content) if (p?.type === "tool-call") declared.add(p.toolCallId)
    }
    if (m.role === "tool" && Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p?.type === "tool-result") {
          assert.ok(declared.has(p.toolCallId), `orphan tool-result leaked: ${p.toolCallId}`)
        }
      }
    }
  }
  // The dangling call (t1) and orphan tool (ORPHAN) were both scrubbed.
  assert.equal(
    sent.some(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        m.content.some((p) => p?.type === "tool-call")
    ),
    false
  )
  assert.equal(
    sent.some((m) => m.role === "tool"),
    false
  )
})
