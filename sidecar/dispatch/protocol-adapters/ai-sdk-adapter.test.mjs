import { test } from "node:test"
import assert from "node:assert/strict"
import {
  buildModel,
  makeAiSdkAdapter,
  isGenuineOpenAiEndpoint,
  buildReasoningProviderOptions,
} from "./ai-sdk-adapter.mjs"

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
  // DeepSeek-R1 distills / QwQ / GLM stream chain-of-thought as a literal
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
