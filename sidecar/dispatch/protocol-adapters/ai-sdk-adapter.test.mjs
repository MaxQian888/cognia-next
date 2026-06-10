import { test } from "node:test"
import assert from "node:assert/strict"
import { buildModel, makeAiSdkAdapter, isGenuineOpenAiEndpoint } from "./ai-sdk-adapter.mjs"

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
