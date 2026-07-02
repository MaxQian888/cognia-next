// Golden-file translation tests for the AI SDK -> SDKMessage event adapter.
// Run with `pnpm --filter cognia-claude-sidecar test` or `node --test`.

import { test } from "node:test"
import assert from "node:assert/strict"
import { createEventAdapter, shapeToolResultContent } from "./event-adapter.mjs"

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
  // The text-delta streams incremental frames right after (message_start first).
  assert.equal(out[1].type, "stream_event")
  assert.equal(out[1].event.type, "message_start")
})

test("text/reasoning deltas stream as message_start + content_block_delta frames", () => {
  const adapter = createEventAdapter(baseCtx())
  const first = adapter.handle({ type: "text-delta", text: "Hel" })
  // No full assistant snapshot per delta — only incremental stream frames.
  assert.ok(!first.some((m) => m.type === "assistant"))
  const kinds = first.map((m) => m.event?.type).filter(Boolean)
  assert.ok(kinds.includes("message_start"))
  assert.ok(kinds.includes("content_block_delta"))
  const delta = first.find((m) => m.event?.type === "content_block_delta").event.delta
  assert.deepEqual(delta, { type: "text_delta", text: "Hel" })
  // Second delta: content_block_delta only (message_start is once-per-message id).
  const second = adapter.handle({ type: "text-delta", text: "lo" })
  assert.ok(second.every((m) => m.type === "stream_event"))
  assert.ok(!second.some((m) => m.event?.type === "message_start"))
  // Reasoning streams as a thinking_delta.
  const r = adapter.handle({ type: "reasoning-delta", text: "hmm" })
  const rDelta = r.find((m) => m.event?.type === "content_block_delta").event.delta
  assert.deepEqual(rDelta, { type: "thinking_delta", thinking: "hmm" })
})

test("sealAssistant() returns [] when nothing is buffered", () => {
  const adapter = createEventAdapter(baseCtx())
  assert.deepEqual(adapter.sealAssistant(), [])
})

test("sealAssistant() seals streamed text into a canonical assistant sharing the stream id", () => {
  const adapter = createEventAdapter(baseCtx())
  const start = adapter.handle({ type: "text-delta", text: "hi" })
  const streamId = start.find((m) => m.event?.type === "message_start").event.message.id
  const sealed = adapter.sealAssistant().find((m) => m.type === "assistant")
  assert.equal(sealed.message.id, streamId)
  assert.equal(sealed.message.content[0].text, "hi")
})

test("setModel retags subsequent assistant snapshots without touching the init message", () => {
  const adapter = createEventAdapter(baseCtx())
  // First turn streams under the original model.
  const first = adapter.handle({ type: "text-delta", id: "1", text: "hi" })
  assert.equal(first[0].model, "gpt-4o-mini", "init keeps the original model")
  assert.equal(
    adapter.sealAssistant().find((m) => m.type === "assistant").message.model,
    "gpt-4o-mini"
  )

  // Live switch, then a fresh turn (reset clears per-turn buffers).
  adapter.setModel("gpt-4o")
  adapter.reset()
  const second = adapter.handle({ type: "text-delta", id: "2", text: "again" })
  // The once-per-session init is NOT re-emitted; the sealed snapshot for the new
  // turn is tagged with the switched model.
  assert.ok(!second.some((m) => m.type === "system"), "init stays once-per-session")
  assert.equal(adapter.sealAssistant().find((m) => m.type === "assistant").message.model, "gpt-4o")
})

test("setModel ignores empty / non-string values (can't blank the model)", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.setModel("")
  adapter.setModel(undefined)
  adapter.setModel(42)
  adapter.handle({ type: "text-delta", id: "1", text: "x" })
  assert.equal(
    adapter.sealAssistant().find((m) => m.type === "assistant").message.model,
    "gpt-4o-mini"
  )
})

// ── AI SDK v6 field shapes (ai@6) ──────────────────────────────────────────
// v6 renamed the high-level fullStream fields: text-delta/reasoning-delta carry
// `text` (not `textDelta`), tool-result carries `output` (not `result`), and a
// thrown tool execute surfaces as a distinct `tool-error` part.

test("v6 text-delta uses `text` and accumulates non-empty assistant text", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "text-delta", id: "1", text: "Hello" })
  const assistant = adapter.sealAssistant().find((m) => m.type === "assistant")
  assert.equal(assistant.message.content[0].type, "text")
  assert.equal(assistant.message.content[0].text, "Hello")
})

test("v6 reasoning-delta uses `text`", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "reasoning-delta", id: "1", text: "thinking..." })
  const assistant = adapter.sealAssistant().find((m) => m.type === "assistant")
  const thinking = assistant.message.content.find((b) => b.type === "thinking")
  assert.equal(thinking.thinking, "thinking...")
})

test("v6 tool-result reads `output`", () => {
  const adapter = createEventAdapter(baseCtx())
  const out = adapter.handle({ type: "tool-result", toolCallId: "c1", output: "done" })
  const user = out.find((m) => m.type === "user")
  assert.equal(user.message.content[0].type, "tool_result")
  assert.equal(user.message.content[0].content, "done")
  assert.equal(user.message.content[0].tool_use_id, "c1")
})

test("shapeToolResultContent stringifies text/object results but keeps image blocks structured", () => {
  // Plain string passes through.
  assert.equal(shapeToolResultContent("hello"), "hello")
  // A non-image object is JSON-stringified (unchanged behavior).
  assert.equal(
    shapeToolResultContent({ content: [{ type: "text", text: "x" }] }),
    '{"content":[{"type":"text","text":"x"}]}'
  )
  // An MCP image result keeps its structured blocks so the TUI can render it.
  const blocks = [
    { type: "text", text: "shot.png" },
    { type: "image", data: "QUJD", mimeType: "image/png" },
  ]
  assert.deepEqual(shapeToolResultContent({ content: blocks }), blocks)
})

test("v6 tool-result with an image keeps structured content (no base64 wall)", () => {
  const adapter = createEventAdapter(baseCtx())
  const out = adapter.handle({
    type: "tool-result",
    toolCallId: "c3",
    output: { content: [{ type: "image", data: "QUJD", mimeType: "image/png" }] },
  })
  const user = out.find((m) => m.type === "user")
  const block = user.message.content[0]
  assert.equal(block.type, "tool_result")
  // Content is the structured array, not a JSON string — the renderer's image
  // extractor needs the blocks to render inline + elide the base64.
  assert.ok(Array.isArray(block.content))
  assert.equal(block.content[0].type, "image")
  assert.equal(block.content[0].data, "QUJD")
})

test("v6 tool-error projects an errored tool_result the model can recover from", () => {
  const adapter = createEventAdapter(baseCtx())
  const out = adapter.handle({ type: "tool-error", toolCallId: "c2", error: new Error("nope") })
  const user = out.find((m) => m.type === "user")
  assert.equal(user.message.content[0].is_error, true)
  assert.match(user.message.content[0].content, /nope/)
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
  adapter.handle({ type: "text-delta", textDelta: "!" })
  const last = adapter.sealAssistant().find((m) => m.type === "assistant")
  assert.equal(last.type, "assistant")
  assert.equal(last.message.content.length, 1)
  assert.equal(last.message.content[0].type, "text")
  assert.equal(last.message.content[0].text, "Hello, world!")
})

test("reasoning events go to a thinking content block", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "reasoning-delta", textDelta: "I should " })
  adapter.handle({ type: "reasoning-delta", textDelta: "think first." })
  const last = adapter.sealAssistant().find((m) => m.type === "assistant")
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
  assert.equal(result.usage.reasoning_tokens, 0) // not reported this turn
})

test("finish() surfaces contextInputTokens as context_input_tokens (window prompt)", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "text-delta", textDelta: "ok" })
  const out = adapter.finish({
    usage: { inputTokens: 3000, outputTokens: 40, contextInputTokens: 1000 },
  })
  const result = out.find((m) => m.type === "result")
  // input_tokens stays the summed billing figure; context_input_tokens carries
  // the last-leg prompt that actually occupies the window.
  assert.equal(result.usage.input_tokens, 3000)
  assert.equal(result.usage.context_input_tokens, 1000)
})

test("finish() omits context_input_tokens when the channel reports none", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "text-delta", textDelta: "ok" })
  const out = adapter.finish({ usage: { inputTokens: 12, outputTokens: 7 } })
  const result = out.find((m) => m.type === "result")
  assert.equal(result.usage.context_input_tokens, undefined)
})

test("finish() surfaces AI SDK v6 reasoningTokens as reasoning_tokens", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "text-delta", textDelta: "ok" })
  const out = adapter.finish({
    usage: { inputTokens: 10, outputTokens: 40, reasoningTokens: 32 },
  })
  const result = out.find((m) => m.type === "result")
  assert.equal(result.usage.output_tokens, 40)
  // reasoning tokens are a SUBSET of output — surfaced for observability.
  assert.equal(result.usage.reasoning_tokens, 32)
})

test("finish() maps AI SDK v6 cachedInputTokens to cache_read_input_tokens", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "text-delta", textDelta: "ok" })
  const out = adapter.finish({
    usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 64 },
  })
  const result = out.find((m) => m.type === "result")
  assert.equal(result.usage.cache_read_input_tokens, 64)
})

test("finish() maps DeepSeek raw prompt_cache_hit_tokens to cache_read_input_tokens", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "text-delta", textDelta: "ok" })
  const out = adapter.finish({
    usage: { inputTokens: 100, outputTokens: 10, prompt_cache_hit_tokens: 128 },
  })
  const result = out.find((m) => m.type === "result")
  assert.equal(result.usage.cache_read_input_tokens, 128)
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
  const idA = a.find((m) => m.event?.type === "message_start").event.message.id
  adapter.handle({
    type: "tool-call",
    toolCallId: "call-1",
    toolName: "Read",
    args: {},
  })
  const c = adapter.handle({ type: "text-delta", textDelta: "after" })
  const idC = c.find((m) => m.event?.type === "message_start").event.message.id
  // Different message ids signal the renderer's id-keyed dedup that this is
  // a new assistant message.
  assert.notEqual(idA, idC)
})

// ── Multi-turn reset (duplicate-output regression) ─────────────────────────
// The adapter is created once per session but its content buffers are
// turn-scoped. reset() must be called at each turn's head so a later turn never
// re-emits the previous turn's reply prepended to its own.

test("reset() clears turn-scoped text so a new turn does not duplicate the old reply", () => {
  const adapter = createEventAdapter(baseCtx())
  // Turn 1.
  adapter.handle({ type: "text-delta", text: "Hello from turn one." })
  adapter.finish({ usage: { inputTokens: 5, outputTokens: 4 } })
  // Turn 2 begins — the head-of-turn reset clears the accumulator.
  adapter.reset()
  adapter.handle({ type: "text-delta", text: "Reply for turn two." })
  const textBlock = adapter
    .sealAssistant()
    .find((m) => m.type === "assistant")
    .message.content.find((b) => b.type === "text")
  assert.equal(textBlock.text, "Reply for turn two.")
})

test("reset() drops a prior turn's tool_use, reasoning, and citations", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "reasoning-delta", text: "thinking" })
  adapter.handle({ type: "tool-call", toolCallId: "c1", toolName: "Read", args: {} })
  adapter.handle({ type: "text-delta", text: "done" })
  adapter.handle({ type: "source-url", url: "https://a.dev", title: "A" })
  adapter.reset()
  adapter.handle({ type: "text-delta", text: "fresh" })
  const assistant = adapter.sealAssistant().find((m) => m.type === "assistant")
  // Only the new text — no carried-over tool_use / thinking / citations.
  assert.equal(assistant.message.content.length, 1)
  assert.equal(assistant.message.content[0].type, "text")
  assert.equal(assistant.message.content[0].text, "fresh")
  assert.equal(assistant.message.content[0].citations, undefined)
})

test("reset() assigns a fresh message id so turns are not merged by dedup", () => {
  const adapter = createEventAdapter(baseCtx())
  const a = adapter.handle({ type: "text-delta", text: "turn one" })
  const idA = a.find((m) => m.event?.type === "message_start").event.message.id
  adapter.reset()
  const b = adapter.handle({ type: "text-delta", text: "turn two" })
  const idB = b.find((m) => m.event?.type === "message_start").event.message.id
  assert.notEqual(idA, idB)
})

test("reset() does not re-emit a second init message", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "text-delta", text: "one" })
  adapter.reset()
  const out = adapter.handle({ type: "text-delta", text: "two" })
  assert.equal(out.filter((m) => m.type === "system").length, 0)
})

// ── Provider citations / sources ───────────────────────────────────────────
// AI SDK v6 surfaces web-search / url / document citations as `source-url` /
// `source-document` (older: `source` + sourceType) stream parts. They are
// projected onto the assistant text block in the Anthropic `citations` shape
// so the renderer's existing extractAnthropicCitations pipeline surfaces them.

test("source-url part attaches an Anthropic-shaped citation to the text block", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "text-delta", text: "Per the docs, " })
  const out = adapter.handle({
    type: "source-url",
    id: "s1",
    url: "https://example.com/a",
    title: "Example A",
  })
  const assistant = out.find((m) => m.type === "assistant")
  const textBlock = assistant.message.content.find((b) => b.type === "text")
  assert.deepEqual(textBlock.citations, [
    { type: "url_citation", url: "https://example.com/a", title: "Example A" },
  ])
})

test("older `source` + sourceType:url form is handled too", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "text-delta", text: "answer" })
  const out = adapter.handle({
    type: "source",
    sourceType: "url",
    url: "https://x.dev",
    title: "X",
  })
  const textBlock = out
    .find((m) => m.type === "assistant")
    .message.content.find((b) => b.type === "text")
  assert.equal(textBlock.citations[0].url, "https://x.dev")
})

test("source-document part becomes a document citation", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "text-delta", text: "answer" })
  const out = adapter.handle({
    type: "source-document",
    id: "d1",
    mediaType: "application/pdf",
    title: "Spec.pdf",
  })
  const textBlock = out
    .find((m) => m.type === "assistant")
    .message.content.find((b) => b.type === "text")
  assert.deepEqual(textBlock.citations, [
    { type: "document", document_title: "Spec.pdf", title: "Spec.pdf" },
  ])
})

test("duplicate sources (same url) collapse to a single citation", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "text-delta", text: "answer" })
  adapter.handle({ type: "source-url", url: "https://dup.com", title: "Dup" })
  const out = adapter.handle({ type: "source-url", url: "https://dup.com", title: "Dup again" })
  const textBlock = out
    .find((m) => m.type === "assistant")
    .message.content.find((b) => b.type === "text")
  assert.equal(textBlock.citations.length, 1, "same url deduped")
})

test("a citation with no url and no title is ignored", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "text-delta", text: "answer" })
  const out = adapter.handle({ type: "source-url", id: "empty" })
  const textBlock = out
    .find((m) => m.type === "assistant")
    .message.content.find((b) => b.type === "text")
  assert.equal(textBlock.citations, undefined, "no citations attached for an empty source")
})

test("text blocks without sources carry no citations field", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "text-delta", text: "plain" })
  const textBlock = adapter
    .sealAssistant()
    .find((m) => m.type === "assistant")
    .message.content.find((b) => b.type === "text")
  assert.equal(textBlock.citations, undefined)
})
