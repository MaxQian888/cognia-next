import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  buildModel,
  makeAiSdkAdapter,
  isGenuineOpenAiEndpoint,
  isResponsesOnlyEndpoint,
  buildReasoningProviderOptions,
  buildCodexResponsesProviderOptions,
  withReasoningExtraction,
} from "./ai-sdk-adapter.mjs"
import { createEventAdapter } from "../event-adapter.mjs"

test("buildModel throws on unsupported protocols", async () => {
  await assert.rejects(() => buildModel({ protocol: "smoke-signal", model: "m" }), /unsupported/)
})

test("isGenuineOpenAiEndpoint distinguishes api.openai.com from compatible gateways", () => {
  // Genuine OpenAI (or no base URL = the default OpenAI endpoint) → Responses API.
  assert.equal(isGenuineOpenAiEndpoint(undefined), true)
  assert.equal(isGenuineOpenAiEndpoint("https://api.openai.com/v1"), true)
  assert.equal(isGenuineOpenAiEndpoint("https://eu.api.openai.com/v1"), true)
  // Compatible gateways → Chat Completions.
  assert.equal(isGenuineOpenAiEndpoint("https://api.deepseek.com/v1"), false)
  assert.equal(isGenuineOpenAiEndpoint("https://opencode.ai/zen/go/v1"), false)
  assert.equal(isGenuineOpenAiEndpoint("http://localhost:11434/v1"), false)
  assert.equal(isGenuineOpenAiEndpoint("not a url"), false)
})

test("buildModel(openai) uses Chat Completions for a compatible gateway base URL", async () => {
  // @ai-sdk/openai v3 defaults `client(model)` to the Responses API (`/responses`),
  // which OpenAI-compatible gateways (DeepSeek/OpenCode/Groq/local) don't serve
  // → 404. A custom non-OpenAI base URL must build via `.chat()` (/chat/completions).
  const m = await buildModel({
    protocol: "openai",
    model: "gpt-4o-mini",
    apiKey: "sk",
    baseURL: "https://gateway.example/v1",
  })
  assert.equal(m.provider, "openai.chat")
})

test("buildModel(openai) uses the Responses API for genuine OpenAI", async () => {
  const m = await buildModel({
    protocol: "openai",
    model: "gpt-4o-mini",
    apiKey: "sk",
    baseURL: "https://api.openai.com/v1",
  })
  assert.equal(m.provider, "openai.responses")
})

test("buildModel(openai) defaults to the Responses API when no base URL is set", async () => {
  const m = await buildModel({ protocol: "openai", model: "gpt-4o-mini", apiKey: "sk" })
  assert.equal(m.provider, "openai.responses")
})

test("isResponsesOnlyEndpoint detects the Codex ChatGPT backend", () => {
  assert.equal(isResponsesOnlyEndpoint("https://chatgpt.com/backend-api/codex"), true)
  assert.equal(isResponsesOnlyEndpoint("https://chat.openai.com/backend-api/codex"), true)
  // Genuine OpenAI is handled by isGenuineOpenAiEndpoint, not this helper.
  assert.equal(isResponsesOnlyEndpoint("https://api.openai.com/v1"), false)
  assert.equal(isResponsesOnlyEndpoint("https://gateway.example/v1"), false)
  assert.equal(isResponsesOnlyEndpoint(undefined), false)
  assert.equal(isResponsesOnlyEndpoint("not a url"), false)
})

test("buildModel(openai) honors an explicit apiFlavor over the host heuristic", async () => {
  // A gateway base URL would heuristically be Chat; apiFlavor:"responses" forces
  // the Responses API (the mechanism that unlocks it on gateways/custom URLs).
  const r = await buildModel({
    protocol: "openai",
    model: "gpt-4o-mini",
    apiKey: "sk",
    baseURL: "https://gateway.example/v1",
    apiFlavor: "responses",
  })
  assert.equal(r.provider, "openai.responses")
  // And apiFlavor:"chat" forces Chat even on genuine OpenAI.
  const c = await buildModel({
    protocol: "openai",
    model: "gpt-4o-mini",
    apiKey: "sk",
    baseURL: "https://api.openai.com/v1",
    apiFlavor: "chat",
  })
  assert.equal(c.provider, "openai.chat")
})

test("buildModel(azure): auto → chat, apiFlavor:responses → responses", async () => {
  const auto = await buildModel({
    protocol: "azure",
    model: "gpt-5",
    apiKey: "az",
    baseURL: "https://x.openai.azure.com",
  })
  assert.equal(auto.provider, "azure.chat", "Azure defaults to chat (conservative)")
  const resp = await buildModel({
    protocol: "azure",
    model: "gpt-5",
    apiKey: "az",
    baseURL: "https://x.openai.azure.com",
    apiFlavor: "responses",
  })
  assert.equal(resp.provider, "azure.responses", "apiFlavor opts Azure into Responses")
})

test("buildModel(bedrock) builds an amazon-bedrock model from a direct API key", async () => {
  const m = await buildModel({
    protocol: "bedrock",
    model: "anthropic.claude-3-haiku-20240307-v1:0",
    apiKey: "bedrock-bearer",
    bedrockAuthMode: "api-key",
    region: "us-east-1",
  })
  assert.equal(m.provider, "amazon-bedrock")
})

test("buildModel(bedrock) accepts explicit IAM credentials", async () => {
  const m = await buildModel({
    protocol: "bedrock",
    model: "us.amazon.nova-lite-v1:0",
    bedrockAuthMode: "iam",
    region: "eu-west-1",
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
    sessionToken: "session",
  })
  assert.equal(m.provider, "amazon-bedrock")
})

test("buildModel(openai) routes the Codex ChatGPT backend to the Responses API", async () => {
  // chatgpt.com is not *.openai.com, so without the responses-only override this
  // would wrongly build via .chat() — which the Codex backend rejects.
  const m = await buildModel({
    protocol: "openai",
    model: "gpt-5.2-codex",
    apiKey: "chatgpt-bearer",
    baseURL: "https://chatgpt.com/backend-api/codex",
    headers: { "ChatGPT-Account-Id": "acct_123", "OAI-Product-Sku": "codex" },
  })
  assert.equal(m.provider, "openai.responses")
})

test("buildModel(openai) routes a Codex RELAY preset to the Responses API via providerId", async () => {
  // Regression: the sidecar called decideOpenAiEndpointFlavor WITHOUT providerId,
  // so RESPONSES_ONLY_PROVIDERS(["codex"]) was dead here and a codex account on a
  // third-party relay preset (wire_api="responses") built via .chat() — which the
  // relay doesn't serve. The renderer passed providerId and disagreed.
  const m = await buildModel({
    protocol: "openai",
    model: "gpt-5.6-sol",
    apiKey: "sk-relay",
    baseURL: "https://ai-pixel.online",
    providerId: "codex",
  })
  assert.equal(m.provider, "openai.responses")
})

test("buildModel(openai) leaves a non-codex gateway on Chat Completions", async () => {
  // The providerId arm must not drag other openai-protocol gateways onto /responses.
  const m = await buildModel({
    protocol: "openai",
    model: "deepseek-chat",
    apiKey: "sk",
    baseURL: "https://api.deepseek.com/v1",
    providerId: "deepseek",
  })
  assert.equal(m.provider, "openai.chat")
})

test("buildReasoningProviderOptions(openai): the Codex backend + relay are native surfaces", () => {
  // Regression: the gate was isGenuineOpenAiEndpoint(baseURL), false for both of
  // these, so reasoningEffort/reasoningSummary were dropped on the whole Codex
  // subscription path — every Codex model is a reasoning model, so reasoning ran
  // off and invisible.
  const expected = { openai: { reasoningEffort: "high", reasoningSummary: "auto" } }
  assert.deepEqual(
    buildReasoningProviderOptions("openai", "https://chatgpt.com/backend-api/codex", {
      effort: "high",
    }),
    expected
  )
  assert.deepEqual(
    buildReasoningProviderOptions(
      "openai",
      "https://ai-pixel.online",
      { effort: "high" },
      {
        providerId: "codex",
      }
    ),
    expected
  )
  // A compatible gateway still opts out (it may 400 on the unknown field).
  assert.equal(
    buildReasoningProviderOptions(
      "openai",
      "https://api.deepseek.com/v1",
      { effort: "high" },
      {
        providerId: "deepseek",
      }
    ),
    null
  )
})

test("buildCodexResponsesProviderOptions: store:false, encrypted reasoning only when reasoning is on", () => {
  // Matches openai/codex build_responses_request: store:false always (non-Azure),
  // include:["reasoning.encrypted_content"] only when reasoning is enabled.
  assert.deepEqual(
    buildCodexResponsesProviderOptions({
      providerId: "codex",
      flavor: "responses",
      hasReasoning: true,
    }),
    { openai: { store: false, include: ["reasoning.encrypted_content"] } }
  )
  assert.deepEqual(
    buildCodexResponsesProviderOptions({
      providerId: "codex",
      flavor: "responses",
      hasReasoning: false,
    }),
    { openai: { store: false } }
  )
  // Scoped: the general openai provider keeps the server's storage default.
  assert.equal(
    buildCodexResponsesProviderOptions({
      providerId: "openai",
      flavor: "responses",
      hasReasoning: true,
    }),
    null
  )
  // A codex row forced onto chat completions has no responses fields to send.
  assert.equal(
    buildCodexResponsesProviderOptions({ providerId: "codex", flavor: "chat", hasReasoning: true }),
    null
  )
})

test("start merges the Codex responses fields with reasoning into one openai block", async () => {
  let captured = null
  const fakeStreamText = (args) => {
    captured = args
    return { fullStream: (async function* () {})(), usage: Promise.resolve({}) }
  }
  await makeAiSdkAdapter("openai").start({
    model: "gpt-5.6-sol",
    messages: [],
    providerId: "codex",
    credentials: { apiKey: "bearer", baseURL: "https://chatgpt.com/backend-api/codex" },
    reasoning: { effort: "high" },
    streamTextFn: fakeStreamText,
  })
  assert.deepEqual(captured.providerOptions, {
    openai: {
      reasoningEffort: "high",
      reasoningSummary: "auto",
      store: false,
      include: ["reasoning.encrypted_content"],
    },
  })
})

test("start passes model/messages/params through to streamText verbatim", async () => {
  let captured = null
  const fakeStreamText = (args) => {
    captured = args
    return { fullStream: (async function* () {})(), usage: Promise.resolve({}) }
  }
  const adapter = makeAiSdkAdapter("openai")
  assert.equal(adapter.id, "ai-sdk:openai")
  const result = await adapter.start({
    model: "gpt-x",
    messages: [{ role: "user", content: "hi" }],
    modelParams: { temperature: 0.1 },
    credentials: { apiKey: "k" },
    streamTextFn: fakeStreamText,
  })
  assert.ok(result.fullStream)
  assert.equal(captured.messages[0].content, "hi")
  assert.equal(captured.temperature, 0.1)
  assert.equal(captured.tools, undefined) // no tools → no stopWhen
  assert.equal(captured.stopWhen, undefined)
})

test("start hoists leading system messages out of messages, cacheControl intact", async () => {
  // AI SDK 7 rejects `{ role: "system" }` inside `messages`. dispatch/ai-sdk.mjs
  // plants up to three Anthropic cache breakpoints on separate leading system
  // messages; each must arrive with its own providerOptions.
  const cacheControl = { anthropic: { cacheControl: { type: "ephemeral" } } }
  let captured = null
  const fakeStreamText = (args) => {
    captured = args
    return { fullStream: (async function* () {})(), usage: Promise.resolve({}) }
  }
  await makeAiSdkAdapter("anthropic").start({
    model: "claude-x",
    messages: [
      { role: "system", content: "base", providerOptions: cacheControl },
      { role: "system", content: "append", providerOptions: cacheControl },
      { role: "system", content: "per-turn tail" },
      { role: "user", content: "hi" },
    ],
    credentials: { apiKey: "k" },
    streamTextFn: fakeStreamText,
  })

  assert.deepEqual(captured.system, [
    { role: "system", content: "base", providerOptions: cacheControl },
    { role: "system", content: "append", providerOptions: cacheControl },
    { role: "system", content: "per-turn tail" },
  ])
  assert.deepEqual(captured.messages, [{ role: "user", content: "hi" }])
  assert.equal(captured.allowSystemInMessages, undefined)
})

test("start opts a mid-history system message back in instead of reordering it", async () => {
  let captured = null
  const fakeStreamText = (args) => {
    captured = args
    return { fullStream: (async function* () {})(), usage: Promise.resolve({}) }
  }
  await makeAiSdkAdapter("openai").start({
    model: "gpt-x",
    messages: [
      { role: "system", content: "base" },
      { role: "user", content: "hi" },
      { role: "system", content: "mid" },
    ],
    credentials: { apiKey: "k" },
    streamTextFn: fakeStreamText,
  })

  assert.deepEqual(captured.system, [{ role: "system", content: "base" }])
  assert.deepEqual(captured.messages, [
    { role: "user", content: "hi" },
    { role: "system", content: "mid" },
  ])
  assert.equal(captured.allowSystemInMessages, true)
})

test("start wires tools + the maxSteps stop condition when tools exist", async () => {
  let captured = null
  const fakeStreamText = (args) => {
    captured = args
    return { fullStream: (async function* () {})(), usage: Promise.resolve({}) }
  }
  const tools = { my_tool: { execute: async () => "ok" } }
  await makeAiSdkAdapter("openai").start({
    model: "gpt-x",
    messages: [],
    tools,
    maxSteps: 4,
    credentials: { apiKey: "k" },
    streamTextFn: fakeStreamText,
  })
  assert.equal(captured.tools, tools)
  assert.equal(typeof captured.stopWhen, "function")
  assert.equal(captured.stopWhen({ steps: [1, 2, 3] }), false)
  assert.equal(captured.stopWhen({ steps: [1, 2, 3, 4] }), true)
  assert.equal(captured.stopWhen({}), false)
})

test("start forwards prepareStep so callers can change active tools between steps", async () => {
  let captured = null
  const fakeStreamText = (args) => {
    captured = args
    return { fullStream: (async function* () {})(), usage: Promise.resolve({}) }
  }
  const prepareStep = () => ({ activeTools: ["read"] })

  await makeAiSdkAdapter("openai").start({
    model: "gpt-x",
    messages: [],
    tools: { read: { execute: async () => "ok" } },
    prepareStep,
    credentials: { apiKey: "k" },
    streamTextFn: fakeStreamText,
  })

  assert.equal(captured.prepareStep, prepareStep)
})

test("buildReasoningProviderOptions(anthropic): a thinking budget enables extended thinking", () => {
  assert.deepEqual(
    buildReasoningProviderOptions("anthropic", undefined, { maxThinkingTokens: 8000 }),
    {
      anthropic: { thinking: { type: "enabled", budgetTokens: 8000 } },
    }
  )
})

test("buildReasoningProviderOptions(anthropic): effort-only falls back to a budget tier", () => {
  const out = buildReasoningProviderOptions("anthropic", undefined, { effort: "high" })
  assert.equal(out.anthropic.thinking.type, "enabled")
  assert.ok(out.anthropic.thinking.budgetTokens > 0, "effort mapped to a positive budget")
})

test("buildReasoningProviderOptions(google): maps budget to thinkingConfig with thoughts", () => {
  assert.deepEqual(
    buildReasoningProviderOptions("google", undefined, { maxThinkingTokens: 5000 }),
    {
      google: { thinkingConfig: { thinkingBudget: 5000, includeThoughts: true } },
    }
  )
})

test("buildReasoningProviderOptions(openai): reasoningEffort + reasoningSummary only for a genuine OpenAI endpoint", () => {
  // reasoningSummary:"auto" is required — without it OpenAI o-series/gpt-5 emit
  // no reasoning parts in the stream and the user sees nothing.
  assert.deepEqual(
    buildReasoningProviderOptions("openai", "https://api.openai.com/v1", { effort: "medium" }),
    { openai: { reasoningEffort: "medium", reasoningSummary: "auto" } }
  )
  // OpenAI-compatible gateways implement their own reasoning and may 400 on an
  // unknown field — skip enablement (their models still surface reasoning,
  // which the event adapter renders).
  assert.equal(
    buildReasoningProviderOptions("openai", "https://api.deepseek.com/v1", { effort: "medium" }),
    null
  )
})

test("buildReasoningProviderOptions: top effort tiers (xhigh/max) still enable thinking", () => {
  // Regression: EFFORT_TO_BUDGET lacked xhigh/max, so the two HIGHEST levels
  // mapped to undefined and silently turned reasoning OFF — the opposite of
  // what they promise. Every level must yield a positive budget.
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    const a = buildReasoningProviderOptions("anthropic", undefined, { effort })
    assert.ok(a.anthropic.thinking.budgetTokens > 0, `anthropic effort=${effort} → positive budget`)
    const g = buildReasoningProviderOptions("google", undefined, { effort })
    assert.ok(
      g.google.thinkingConfig.thinkingBudget > 0,
      `google effort=${effort} → positive budget`
    )
  }
  // Higher tiers grant strictly larger budgets.
  const high = buildReasoningProviderOptions("anthropic", undefined, { effort: "high" })
  const max = buildReasoningProviderOptions("anthropic", undefined, { effort: "max" })
  assert.ok(max.anthropic.thinking.budgetTokens > high.anthropic.thinking.budgetTokens)
})

test("buildReasoningProviderOptions(openai): 'max' is folded to OpenAI's valid 'xhigh'", () => {
  // OpenAI's reasoningEffort has no "max" — sending it 400s. It must clamp to
  // the nearest valid ceiling.
  assert.deepEqual(
    buildReasoningProviderOptions("openai", "https://api.openai.com/v1", { effort: "max" }),
    { openai: { reasoningEffort: "xhigh", reasoningSummary: "auto" } }
  )
})

test("buildModel wraps every protocol with <think>-tag reasoning extraction", async () => {
  // DeepSeek-R1 distills / QwQ-style models stream chain-of-thought as a literal
  // <think> block in the content; extractReasoningMiddleware must pull it into
  // a reasoning part instead of leaking it into the answer. The wrap is uniform
  // across protocols and preserves provider/modelId.
  const m = await buildModel({
    protocol: "openai",
    model: "deepseek-reasoner",
    apiKey: "sk",
    baseURL: "https://api.deepseek.com/v1",
  })
  assert.equal(m.provider, "openai.chat", "wrap preserves provider")
  assert.equal(m.modelId, "deepseek-reasoner", "wrap preserves modelId")
  // The middleware is observable: a wrapped model exposes the original via the
  // standard wrapLanguageModel shape.
  assert.ok(m, "model built and wrapped")
})

test("gpt-oss streaming fixture marks raw analysis and prevents display or persistence", async () => {
  const fixture = JSON.parse(
    readFileSync(new URL("../fixtures/gpt-oss-raw-analysis-stream.json", import.meta.url), "utf8")
  )
  const rawModel = {
    specificationVersion: "v3",
    provider: "fixture",
    modelId: fixture.model,
    supportedUrls: {},
    doGenerate: async () => ({ content: [], finishReason: "stop", usage: {} }),
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          for (const part of fixture.stream) controller.enqueue(part)
          controller.close()
        },
      }),
    }),
  }
  const model = await withReasoningExtraction(rawModel, fixture.model)
  const result = await model.doStream({ prompt: [] })
  const parts = []
  for await (const part of result.stream) parts.push(part)

  const reasoning = parts.filter((part) => part.type.startsWith("reasoning"))
  assert.ok(reasoning.length > 0, "fixture exercises an extracted reasoning stream")
  assert.ok(
    reasoning.every((part) => part.providerMetadata?.cognia?.reasoningSource === "raw-analysis"),
    "every raw-analysis chunk carries explicit provenance"
  )

  const adapter = createEventAdapter({
    sessionId: "s1",
    sdkSessionId: "sdk1",
    model: fixture.model,
    provider: "openai",
  })
  const wire = []
  for (const part of parts) wire.push(...adapter.handle(part))
  wire.push(...adapter.sealAssistant())
  const serialized = JSON.stringify(wire)
  assert.ok(serialized.includes("Safe final answer."))
  assert.ok(!serialized.includes("private chain of thought"))
  assert.ok(!serialized.includes("thinking_delta"))
})

test("buildReasoningProviderOptions: no reasoning config → null", () => {
  assert.equal(buildReasoningProviderOptions("anthropic", undefined, undefined), null)
  assert.equal(buildReasoningProviderOptions("anthropic", undefined, {}), null)
  assert.equal(buildReasoningProviderOptions("openai", undefined, { maxThinkingTokens: 0 }), null)
})

test("start threads abortSignal into streamText", async () => {
  let captured = null
  const fakeStreamText = (args) => {
    captured = args
    return { fullStream: (async function* () {})(), usage: Promise.resolve({}) }
  }
  const ac = new AbortController()
  await makeAiSdkAdapter("openai").start({
    model: "gpt-x",
    messages: [],
    credentials: { apiKey: "k" },
    abortSignal: ac.signal,
    streamTextFn: fakeStreamText,
  })
  assert.equal(
    captured.abortSignal,
    ac.signal,
    "abortSignal forwarded so the HTTP request can cancel"
  )
})

test("start threads reasoning providerOptions, deep-merged with modelParams.providerOptions", async () => {
  let captured = null
  const fakeStreamText = (args) => {
    captured = args
    return { fullStream: (async function* () {})(), usage: Promise.resolve({}) }
  }
  await makeAiSdkAdapter("anthropic").start({
    model: "claude-x",
    messages: [],
    credentials: { apiKey: "k" },
    // a pre-existing providerOptions block from modelParams must survive
    modelParams: { providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } },
    reasoning: { maxThinkingTokens: 6000 },
    streamTextFn: fakeStreamText,
  })
  assert.deepEqual(captured.providerOptions.anthropic, {
    cacheControl: { type: "ephemeral" },
    thinking: { type: "enabled", budgetTokens: 6000 },
  })
})

test("empty tools object behaves like no tools (historical hasTools check)", async () => {
  let captured = null
  const fakeStreamText = (args) => {
    captured = args
    return { fullStream: (async function* () {})(), usage: Promise.resolve({}) }
  }
  await makeAiSdkAdapter("openai").start({
    model: "gpt-x",
    messages: [],
    tools: {},
    credentials: { apiKey: "k" },
    streamTextFn: fakeStreamText,
  })
  assert.equal(captured.tools, undefined)
})
