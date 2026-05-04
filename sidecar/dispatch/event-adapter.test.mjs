// Golden-file translation tests for the AI SDK -> SDKMessage event adapter.
// Run with `pnpm --filter cognia-claude-sidecar test` or `node --test`.

import { test } from "node:test"
import assert from "node:assert/strict"
import { createEventAdapter } from "./event-adapter.mjs"

const baseCtx = () => ({
  sessionId: "client-sess-1",
  sdkSessionId: "sdk-sess-1",
  model: "gpt-4o-mini",
  provider: "openai",
  startedAt: 1000,
})

test("emits a system init message before the first content event", () => {
  const adapter = createEventAdapter(baseCtx())
  const out = adapter.handle({ type: "text-delta", textDelta: "hello" })
  assert.equal(out[0].type, "system")
  assert.equal(out[0].subtype, "init")
  assert.equal(out[0].session_id, "sdk-sess-1")
  assert.equal(out[0].model, "gpt-4o-mini")
  // The text-delta produces an assistant snapshot right after.
  assert.equal(out[1].type, "assistant")
})

test("init message is only emitted once across many events", () => {
  const adapter = createEventAdapter(baseCtx())
  const a = adapter.handle({ type: "text-delta", textDelta: "h" })
  const b = adapter.handle({ type: "text-delta", textDelta: "i" })
  const initCount =
    a.filter((m) => m.type === "system").length + b.filter((m) => m.type === "system").length
  assert.equal(initCount, 1)
})

test("text-delta accumulates into a single text content block", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "text-delta", textDelta: "Hello, " })
  adapter.handle({ type: "text-delta", textDelta: "world" })
  const out = adapter.handle({ type: "text-delta", textDelta: "!" })
  const last = out[out.length - 1]
  assert.equal(last.type, "assistant")
  assert.equal(last.message.content.length, 1)
  assert.equal(last.message.content[0].type, "text")
  assert.equal(last.message.content[0].text, "Hello, world!")
})

test("reasoning events go to a thinking content block", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "reasoning-delta", textDelta: "I should " })
  const out = adapter.handle({ type: "reasoning-delta", textDelta: "think first." })
  const last = out[out.length - 1]
  const thinking = last.message.content.find((b) => b.type === "thinking")
  assert.ok(thinking, "thinking block present")
  assert.equal(thinking.thinking, "I should think first.")
})

test("tool-call event adds a tool_use block to the assistant message", () => {
  const adapter = createEventAdapter(baseCtx())
  const out = adapter.handle({
    type: "tool-call",
    toolCallId: "call-1",
    toolName: "Read",
    args: { path: "/etc/hosts" },
  })
  const last = out[out.length - 1]
  const tu = last.message.content.find((b) => b.type === "tool_use")
  assert.ok(tu)
  assert.equal(tu.id, "call-1")
  assert.equal(tu.name, "Read")
  assert.deepEqual(tu.input, { path: "/etc/hosts" })
})

test("tool-result event emits a synthetic user message with tool_result block", () => {
  const adapter = createEventAdapter(baseCtx())
  // First tool-call.
  adapter.handle({ type: "tool-call", toolCallId: "call-1", toolName: "Read", args: {} })
  const out = adapter.handle({
    type: "tool-result",
    toolCallId: "call-1",
    result: "127.0.0.1 localhost",
    isError: false,
  })
  const userMsg = out.find((m) => m.type === "user")
  assert.ok(userMsg)
  assert.equal(userMsg.message.content[0].type, "tool_result")
  assert.equal(userMsg.message.content[0].tool_use_id, "call-1")
  assert.equal(userMsg.message.content[0].is_error, false)
  assert.equal(userMsg.message.content[0].content, "127.0.0.1 localhost")
})

test("tool-result with isError flag round-trips", () => {
  const adapter = createEventAdapter(baseCtx())
  const out = adapter.handle({
    type: "tool-result",
    toolCallId: "call-x",
    result: "no such file",
    isError: true,
  })
  const userMsg = out.find((m) => m.type === "user")
  assert.equal(userMsg.message.content[0].is_error, true)
})

test("finish() emits a result message with mapped usage tokens", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "text-delta", textDelta: "ok" })
  const out = adapter.finish({
    totalCostUsd: 0.0042,
    usage: { promptTokens: 12, completionTokens: 7, cacheReadInputTokens: 3 },
  })
  const result = out.find((m) => m.type === "result")
  assert.ok(result)
  assert.equal(result.subtype, "success")
  assert.equal(result.session_id, "sdk-sess-1")
  assert.equal(result.is_error, false)
  assert.equal(result.total_cost_usd, 0.0042)
  assert.equal(result.usage.input_tokens, 12)
  assert.equal(result.usage.output_tokens, 7)
  assert.equal(result.usage.cache_read_input_tokens, 3)
})

test("finish() handles missing usage gracefully", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "text-delta", textDelta: "x" })
  const out = adapter.finish(undefined)
  const result = out.find((m) => m.type === "result")
  assert.ok(result)
  assert.equal(result.usage.input_tokens, 0)
  assert.equal(result.total_cost_usd, 0)
})

test("error events do not emit anything (handled by dispatcher)", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "text-delta", textDelta: "h" })
  const out = adapter.handle({ type: "error", error: new Error("boom") })
  // The init was emitted on the first text-delta, so by now the adapter
  // shouldn't emit anything new for error events.
  assert.deepEqual(out.length, 0)
})

test("unknown event types are ignored after init", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "text-delta", textDelta: "h" })
  const out = adapter.handle({ type: "step-start" })
  assert.deepEqual(out.length, 0)
})

test("text after a tool_use starts a fresh message id", () => {
  const adapter = createEventAdapter(baseCtx())
  const a = adapter.handle({ type: "text-delta", textDelta: "before" })
  const lastA = a[a.length - 1]
  adapter.handle({
    type: "tool-call",
    toolCallId: "call-1",
    toolName: "Read",
    args: {},
  })
  const c = adapter.handle({ type: "text-delta", textDelta: "after" })
  const lastC = c[c.length - 1]
  // Different message ids signal the renderer's id-keyed dedup that this is
  // a new assistant message.
  assert.notEqual(lastA.message.id, lastC.message.id)
})
