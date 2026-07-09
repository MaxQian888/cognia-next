// Golden-file translation tests for the AI SDK -> SDKMessage event adapter.
// Run with `pnpm --filter cognia-claude-sidecar test` or `node --test`.

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  createEventAdapter,
  finishReasonToStopReason,
  shapeToolResultContent,
} from "./event-adapter.mjs"

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

test("AI SDK step boundaries stream as step events", () => {
  const adapter = createEventAdapter(baseCtx())
  const start = adapter.handle({ type: "start-step" })
  assert.deepEqual(start.map((m) => m.event?.type).filter(Boolean), ["message_start", "step_start"])

  const finish = adapter.handle({ type: "finish-step" })
  assert.deepEqual(finish.map((m) => m.event?.type).filter(Boolean), ["step_finish"])
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

test("AI SDK start.messageId controls streamed and sealed assistant ids", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "start", messageId: "sdk-message-1" })
  const start = adapter.handle({ type: "text-delta", text: "hi" })
  assert.equal(
    start.find((m) => m.event?.type === "message_start").event.message.id,
    "sdk-message-1"
  )
  assert.equal(
    adapter.sealAssistant().find((m) => m.type === "assistant").message.id,
    "sdk-message-1"
  )
})

test("AI SDK message metadata chunks update the sealed assistant metadata", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({
    type: "start",
    messageId: "sdk-message-1",
    messageMetadata: { phase: "start" },
  })
  adapter.handle({ type: "text-delta", text: "hi" })
  adapter.handle({ type: "message-metadata", messageMetadata: { phase: "mid" } })
  adapter.handle({
    type: "finish",
    finishReason: "stop",
    messageMetadata: { phase: "finish" },
  })
  const sealed = adapter.sealAssistant().find((m) => m.type === "assistant")
  assert.equal(sealed.message.id, "sdk-message-1")
  assert.deepEqual(sealed.message.metadata, { phase: "finish" })
})

test("finishReasonToStopReason maps only length/content-filter", () => {
  assert.equal(finishReasonToStopReason("length"), "max_tokens")
  assert.equal(finishReasonToStopReason("content-filter"), "refusal")
  assert.equal(finishReasonToStopReason("stop"), null)
  assert.equal(finishReasonToStopReason("tool-calls"), null)
  assert.equal(finishReasonToStopReason(undefined), null)
})

test("sealed assistant carries stop_reason mapped from the finish reason", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "text-delta", text: "partial" })
  adapter.handle({ type: "finish", finishReason: "length" })
  const sealed = adapter.sealAssistant().find((m) => m.type === "assistant")
  assert.equal(sealed.message.stop_reason, "max_tokens")

  // A clean finish leaves stop_reason null (treated as end_turn downstream).
  const clean = createEventAdapter(baseCtx())
  clean.handle({ type: "text-delta", text: "done" })
  clean.handle({ type: "finish", finishReason: "stop" })
  assert.equal(clean.sealAssistant().find((m) => m.type === "assistant").message.stop_reason, null)
})

test("reset() clears the captured stop_reason between turns", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "text-delta", text: "a" })
  adapter.handle({ type: "finish", finishReason: "content-filter" })
  assert.equal(
    adapter.sealAssistant().find((m) => m.type === "assistant").message.stop_reason,
    "refusal"
  )
  adapter.reset()
  adapter.handle({ type: "text-delta", text: "b" })
  assert.equal(
    adapter.sealAssistant().find((m) => m.type === "assistant").message.stop_reason,
    null
  )
})

test("AI SDK message metadata chunks deep-merge non-null updates", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({
    type: "start",
    messageMetadata: {
      phase: "start",
      nested: { keep: true, replace: "start" },
      list: ["start"],
    },
  })
  adapter.handle({
    type: "message-metadata",
    messageMetadata: {
      nested: { replace: "mid", add: 1 },
      list: ["mid"],
      unsafe: "kept",
    },
  })
  adapter.handle({ type: "message-metadata", messageMetadata: null })
  adapter.handle({ type: "message-metadata", messageMetadata: undefined })
  adapter.handle({ type: "text-delta", text: "hi" })
  adapter.handle({
    type: "finish",
    messageMetadata: {
      phase: "finish",
      nested: { add: 2 },
      __proto__: { polluted: true },
    },
  })

  const sealed = adapter.sealAssistant().find((m) => m.type === "assistant")
  assert.deepEqual(sealed.message.metadata, {
    phase: "finish",
    nested: { keep: true, replace: "mid", add: 2 },
    list: ["mid"],
    unsafe: "kept",
  })
  assert.equal({}.polluted, undefined)
})

test("sealAssistant() preserves latest text and reasoning provider metadata", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({
    type: "text-delta",
    text: "Hello",
    providerMetadata: { provider: { phase: "start" } },
  })
  adapter.handle({
    type: "text-delta",
    text: " world",
    providerMetadata: { provider: { phase: "final-text" } },
  })
  adapter.handle({
    type: "reasoning-delta",
    text: "think",
    providerMetadata: { provider: { phase: "final-reasoning" } },
  })
  const content = adapter.sealAssistant().find((m) => m.type === "assistant").message.content
  assert.deepEqual(
    content.find((b) => b.type === "text"),
    {
      type: "text",
      text: "Hello world",
      providerMetadata: { provider: { phase: "final-text" } },
    }
  )
  assert.deepEqual(
    content.find((b) => b.type === "thinking"),
    {
      type: "thinking",
      thinking: "think",
      providerMetadata: { provider: { phase: "final-reasoning" } },
    }
  )
})

test("text/reasoning start and end chunks can set sealed provider metadata", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({
    type: "text-start",
    id: "text-1",
    providerMetadata: { provider: { phase: "text-start" } },
  })
  adapter.handle({ type: "text-delta", id: "text-1", text: "Hello" })
  adapter.handle({
    type: "text-end",
    id: "text-1",
    providerMetadata: { provider: { phase: "text-end" } },
  })
  adapter.handle({
    type: "reasoning-start",
    id: "reasoning-1",
    providerMetadata: { provider: { phase: "reasoning-start" } },
  })
  adapter.handle({ type: "reasoning-delta", id: "reasoning-1", text: "think" })
  adapter.handle({
    type: "reasoning-end",
    id: "reasoning-1",
    providerMetadata: { provider: { phase: "reasoning-end" } },
  })
  const content = adapter.sealAssistant().find((m) => m.type === "assistant").message.content
  assert.deepEqual(
    content.find((b) => b.type === "text"),
    {
      type: "text",
      text: "Hello",
      providerMetadata: { provider: { phase: "text-end" } },
    }
  )
  assert.deepEqual(
    content.find((b) => b.type === "thinking"),
    {
      type: "thinking",
      thinking: "think",
      providerMetadata: { provider: { phase: "reasoning-end" } },
    }
  )
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

test("v6 tool-output-denied projects an errored tool_result for the denied call", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({
    type: "tool-call",
    toolCallId: "c-denied",
    toolName: "write",
    args: { path: "secret.txt" },
  })
  const out = adapter.handle({
    type: "tool-output-denied",
    toolCallId: "c-denied",
    toolName: "write",
  })
  const user = out.find((m) => m.type === "user")
  assert.equal(user.message.content[0].type, "tool_result")
  assert.equal(user.message.content[0].tool_use_id, "c-denied")
  assert.equal(user.message.content[0].is_error, true)
  assert.match(user.message.content[0].content, /write/)
  assert.match(user.message.content[0].content, /denied/i)
})

test("v6 file part emits a generated file as its own one-shot assistant message", () => {
  const adapter = createEventAdapter(baseCtx())
  const out = adapter.handle({
    type: "file",
    file: { base64: "QUJD", mediaType: "image/png" },
    filename: "chart.png",
  })
  const assistant = out.find((m) => m.type === "assistant")
  assert.ok(assistant)
  assert.deepEqual(assistant.message.content, [
    {
      type: "file",
      source: { type: "base64", media_type: "image/png", data: "QUJD" },
      filename: "chart.png",
    },
  ])
  // The base64 payload crosses the stdio pipe exactly once: later snapshots
  // do NOT re-embed it (the accumulate-into-every-snapshot behavior was
  // O(N²) bytes over the wire).
  assert.deepEqual(adapter.sealAssistant(), [])
  adapter.handle({ type: "text-delta", text: "done" })
  assert.deepEqual(adapter.sealAssistant().find((m) => m.type === "assistant").message.content, [
    { type: "text", text: "done" },
  ])
})

test("v6 url file part projects a hosted file onto the assistant snapshot", () => {
  const adapter = createEventAdapter(baseCtx())
  const out = adapter.handle({
    type: "file",
    url: "https://files.example/chart.png",
    mediaType: "image/png",
  })
  const assistant = out.find((m) => m.type === "assistant")
  assert.ok(assistant)
  assert.deepEqual(assistant.message.content, [
    {
      type: "file",
      url: "https://files.example/chart.png",
      media_type: "image/png",
    },
  ])
})

test("v6 streamed tool input creates and upgrades a single tool_use block", () => {
  const adapter = createEventAdapter(baseCtx())
  const started = adapter.handle({
    type: "tool-input-start",
    id: "call-stream",
    toolName: "write",
  })
  const pending = started
    .find((m) => m.type === "assistant")
    .message.content.find((b) => b.type === "tool_use")
  assert.deepEqual(pending, {
    type: "tool_use",
    id: "call-stream",
    name: "write",
    input: {},
    state: "input-streaming",
  })

  // Deltas accumulate silently — no whole-buffer re-parse and no full
  // assistant snapshot per chunk (the O(n²) fix). Split the JSON across two
  // deltas to prove reassembly happens once, at tool-input-end.
  const delta1 = adapter.handle({
    type: "tool-input-delta",
    id: "call-stream",
    delta: '{"path":"secr',
  })
  const delta2 = adapter.handle({
    type: "tool-input-delta",
    id: "call-stream",
    delta: 'et.txt"}',
  })
  assert.equal(
    delta1.find((m) => m.type === "assistant"),
    undefined
  )
  assert.equal(
    delta2.find((m) => m.type === "assistant"),
    undefined
  )

  // tool-input-end finalizes the input: the transient "input-streaming"
  // state is dropped so the block never sticks in-flight when no
  // tool-call / tool-input-available follows.
  const ended = adapter.handle({ type: "tool-input-end", id: "call-stream" })
  const streamed = ended
    .find((m) => m.type === "assistant")
    .message.content.find((b) => b.type === "tool_use")
  assert.deepEqual(streamed, {
    type: "tool_use",
    id: "call-stream",
    name: "write",
    input: { path: "secret.txt" },
  })

  const final = adapter.handle({
    type: "tool-call",
    toolCallId: "call-stream",
    toolName: "write",
    input: { path: "final.txt" },
    providerExecuted: false,
    providerMetadata: { provider: { traceId: "trace-tool" } },
    toolMetadata: { display: "Write file" },
    dynamic: false,
    title: "Write file",
  })
  const toolUses = final
    .find((m) => m.type === "assistant")
    .message.content.filter((b) => b.type === "tool_use")
  assert.deepEqual(toolUses, [
    {
      type: "tool_use",
      id: "call-stream",
      name: "write",
      input: { path: "final.txt" },
      providerExecuted: false,
      providerMetadata: { provider: { traceId: "trace-tool" } },
      toolMetadata: { display: "Write file" },
      dynamic: false,
      title: "Write file",
    },
  ])
})

test("v6 tool-approval-request marks the tool_use as awaiting approval", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({
    type: "tool-call",
    toolCallId: "call-approval",
    toolName: "write",
    input: { path: "secret.txt" },
  })

  const out = adapter.handle({
    type: "tool-approval-request",
    approvalId: "approval-1",
    signature: "sig-1",
    toolCall: {
      type: "tool-call",
      toolCallId: "call-approval",
      toolName: "write",
      input: { path: "secret.txt" },
    },
  })
  const toolUses = out
    .find((m) => m.type === "assistant")
    .message.content.filter((b) => b.type === "tool_use")
  assert.deepEqual(toolUses, [
    {
      type: "tool_use",
      id: "call-approval",
      name: "write",
      input: { path: "secret.txt" },
      state: "approval-requested",
      approval: { id: "approval-1", signature: "sig-1" },
    },
  ])
})

test("v6 tool-approval-request maps metadata from nested toolCall", () => {
  const adapter = createEventAdapter(baseCtx())
  const out = adapter.handle({
    type: "tool-approval-request",
    approvalId: "approval-meta",
    toolCall: {
      type: "tool-call",
      toolCallId: "call-approval-meta",
      toolName: "write",
      input: { path: "secret.txt" },
      providerExecuted: false,
      providerMetadata: { provider: { traceId: "trace-approval" } },
      toolMetadata: { display: "Write file" },
      dynamic: false,
      title: "Write file",
    },
  })
  const toolUses = out
    .find((m) => m.type === "assistant")
    .message.content.filter((b) => b.type === "tool_use")
  assert.deepEqual(toolUses, [
    {
      type: "tool_use",
      id: "call-approval-meta",
      name: "write",
      input: { path: "secret.txt" },
      state: "approval-requested",
      providerExecuted: false,
      providerMetadata: { provider: { traceId: "trace-approval" } },
      toolMetadata: { display: "Write file" },
      dynamic: false,
      title: "Write file",
      approval: { id: "approval-meta" },
    },
  ])
})

test("UI-message tool-input-available finalizes a tool_use block", () => {
  const adapter = createEventAdapter(baseCtx())
  const out = adapter.handle({
    type: "tool-input-available",
    toolCallId: "call-input-ready",
    toolName: "write",
    input: { path: "ready.txt" },
    providerExecuted: false,
    providerMetadata: { provider: { traceId: "trace-ready" } },
    toolMetadata: { display: "Write file" },
    dynamic: true,
    title: "Write file",
  })
  const toolUses = out
    .find((m) => m.type === "assistant")
    .message.content.filter((b) => b.type === "tool_use")
  assert.deepEqual(toolUses, [
    {
      type: "tool_use",
      id: "call-input-ready",
      name: "write",
      input: { path: "ready.txt" },
      providerExecuted: false,
      providerMetadata: { provider: { traceId: "trace-ready" } },
      toolMetadata: { display: "Write file" },
      dynamic: true,
      title: "Write file",
    },
  ])
})

test("UI-message tool output and input errors emit tool_result messages", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({
    type: "tool-input-available",
    toolCallId: "call-output",
    toolName: "write",
    input: { path: "ready.txt" },
  })

  const available = adapter.handle({
    type: "tool-output-available",
    toolCallId: "call-output",
    output: { ok: true },
  })
  const availableResult = available.find((m) => m.type === "user").message.content[0]
  assert.deepEqual(availableResult, {
    type: "tool_result",
    tool_use_id: "call-output",
    content: JSON.stringify({ ok: true }),
    is_error: false,
  })

  const outputError = adapter.handle({
    type: "tool-output-error",
    toolCallId: "call-output",
    errorText: "write failed",
  })
  const outputErrorResult = outputError.find((m) => m.type === "user").message.content[0]
  assert.deepEqual(outputErrorResult, {
    type: "tool_result",
    tool_use_id: "call-output",
    content: "write failed",
    is_error: true,
  })

  const inputError = adapter.handle({
    type: "tool-input-error",
    toolCallId: "call-input-error",
    toolName: "write",
    input: { path: "bad.txt" },
    errorText: "invalid input",
  })
  const inputErrorResult = inputError.find((m) => m.type === "user").message.content[0]
  assert.deepEqual(inputErrorResult, {
    type: "tool_result",
    tool_use_id: "call-input-error",
    content: "invalid input",
    is_error: true,
  })
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

test("handled finish event uses AI SDK totalUsage when present", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "text-delta", textDelta: "ok" })
  adapter.handle({
    type: "finish",
    totalUsage: { inputTokens: 8, outputTokens: 3, reasoningTokens: 1 },
  })
  const out = adapter.finish()
  const result = out.find((m) => m.type === "result")
  assert.equal(result.usage.input_tokens, 8)
  assert.equal(result.usage.output_tokens, 3)
  assert.equal(result.usage.reasoning_tokens, 1)
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

test("finish() maps exact AI SDK LanguageModelUsage nested token details", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "text-delta", textDelta: "ok" })
  const out = adapter.finish({
    usage: {
      inputTokens: 10,
      outputTokens: 6,
      inputTokenDetails: {
        cacheReadTokens: 4,
        cacheWriteTokens: 2,
      },
      outputTokenDetails: {
        reasoningTokens: 3,
      },
    },
  })
  const result = out.find((m) => m.type === "result")
  assert.equal(result.usage.cache_read_input_tokens, 4)
  assert.equal(result.usage.cache_creation_input_tokens, 2)
  assert.equal(result.usage.reasoning_tokens, 3)
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

test("raw provider frames are accepted but not rendered or sealed", () => {
  const adapter = createEventAdapter(baseCtx())
  assert.equal(adapter.handle({ type: "raw", rawValue: { vendor: "frame" } }).length, 1)
  assert.deepEqual(adapter.sealAssistant(), [])
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

test("text after a tool_use does not duplicate prior text/tool_use in the sealed message", () => {
  // Regression: a single leg (default STEP_CHUNK, no reset() between steps) that
  // streams text → tool_use → more text. The tool→text boundary rotates the
  // messageId; before the fix it left textBuf + completedToolUses populated, so
  // the post-boundary snapshot re-emitted "before" and the tool_use under the
  // new id (duplicate output). The fresh message must carry ONLY the new text.
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "text-delta", textDelta: "before" })
  adapter.handle({ type: "tool-call", toolCallId: "call-1", toolName: "Read", args: {} })
  adapter.handle({ type: "text-delta", textDelta: "after" })
  const assistant = adapter.sealAssistant().find((m) => m.type === "assistant")
  assert.ok(assistant)
  // No re-emitted tool_use, no "beforeafter" concatenation.
  assert.equal(assistant.message.content.length, 1)
  assert.equal(assistant.message.content[0].type, "text")
  assert.equal(assistant.message.content[0].text, "after")
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

test("duplicate document sources collapse to a single citation", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "text-delta", text: "answer" })
  adapter.handle({ type: "source-document", id: "d1", title: "Spec.pdf" })
  const out = adapter.handle({ type: "source-document", id: "d1b", title: "Spec.pdf" })
  const textBlock = out
    .find((m) => m.type === "assistant")
    .message.content.find((b) => b.type === "text")
  assert.equal(textBlock.citations.length, 1)
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

test("reasoning after a sealed tool_use rotates the message boundary (no re-emitted tool_uses)", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "tool-call", toolCallId: "t1", toolName: "grep", input: {} })
  // Interleaved thinking: reasoning arrives AFTER the tool_use was sealed.
  const reasoningOut = adapter.handle({ type: "reasoning-delta", text: "thinking..." })
  // Then text — the fresh message must NOT carry the prior tool_use.
  adapter.handle({ type: "text-delta", text: "answer" })
  const sealed = adapter.sealAssistant()
  const assistant = sealed.find((m) => m.type === "assistant")
  assert.ok(assistant, "expected a sealed assistant snapshot")
  const kinds = assistant.message.content.map((b) => b.type)
  assert.ok(!kinds.includes("tool_use"), `sealed message re-emitted tool_use: ${kinds}`)
  // And the reasoning stream started a new message id (message_start again).
  const types = reasoningOut.map((m) => m.event?.type).filter(Boolean)
  assert.ok(types.includes("message_start"))
})

test("tool-result with only a nested toolCall id still pairs the result", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "tool-call", toolCallId: "t9", toolName: "read", input: {} })
  const out = adapter.handle({
    type: "tool-result",
    toolCall: { toolCallId: "t9" },
    output: "body",
  })
  const result = out.find((m) => m.type === "user")
  assert.ok(result)
  assert.equal(result.message.content[0].tool_use_id, "t9")
})

test("circular tool output does not throw out of handle()", () => {
  const adapter = createEventAdapter(baseCtx())
  adapter.handle({ type: "tool-call", toolCallId: "c1", toolName: "x", input: {} })
  const loop = {}
  loop.self = loop
  assert.doesNotThrow(() => adapter.handle({ type: "tool-error", toolCallId: "c1", error: loop }))
})
