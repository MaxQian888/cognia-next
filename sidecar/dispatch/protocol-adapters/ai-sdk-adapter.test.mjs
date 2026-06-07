import { test } from "node:test"
import assert from "node:assert/strict"
import { buildModel, makeAiSdkAdapter } from "./ai-sdk-adapter.mjs"

test("buildModel throws on unsupported protocols", async () => {
  await assert.rejects(() => buildModel({ protocol: "smoke-signal", model: "m" }), /unsupported/)
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
