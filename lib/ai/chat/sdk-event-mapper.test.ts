import { createSdkEventMapper, shapeToolResultContent } from "./sdk-event-mapper"

// Deterministic ids so we can assert snapshot identity within a turn and that a
// fresh id is minted across boundaries / turns.
let uuidCounter = 0
beforeEach(() => {
  uuidCounter = 0
  jest
    .spyOn(globalThis.crypto, "randomUUID")
    .mockImplementation(
      () => `uuid-${++uuidCounter}` as `${string}-${string}-${string}-${string}-${string}`
    )
})
afterEach(() => jest.restoreAllMocks())

type AnyMsg = {
  type: string
  subtype?: string
  message?: { id?: string; content?: Array<Record<string, unknown>>; role?: string }
  usage?: Record<string, number>
  event?: { type?: string; delta?: Record<string, unknown>; message?: { id?: string } }
}

const ctx = {
  sessionId: "s1",
  sdkSessionId: "sdk1",
  model: "claude-sonnet-4-6",
  provider: "anthropic",
}

function assistantContent(msgs: AnyMsg[]): Array<Record<string, unknown>> {
  const last = msgs.filter((m) => m.type === "assistant").at(-1)
  return (last?.message?.content ?? []) as Array<Record<string, unknown>>
}

describe("shapeToolResultContent", () => {
  it("passes a plain string through unchanged", () => {
    expect(shapeToolResultContent("hello")).toBe("hello")
  })
  it("JSON-stringifies non-string, non-image payloads", () => {
    expect(shapeToolResultContent({ a: 1 })).toBe(JSON.stringify({ a: 1 }))
  })
  it("forwards an MCP image-content array verbatim", () => {
    const payload = { content: [{ type: "image", data: "base64", mimeType: "image/png" }] }
    expect(shapeToolResultContent(payload)).toBe(payload.content)
  })
})

describe("createSdkEventMapper", () => {
  it("emits the init system message exactly once, before the first snapshot", () => {
    const m = createSdkEventMapper(ctx)
    const first = m.handle({ type: "text-delta", text: "hi" }) as AnyMsg[]
    expect(first[0]).toMatchObject({ type: "system", subtype: "init", model: "claude-sonnet-4-6" })
    const second = m.handle({ type: "text-delta", text: " there" }) as AnyMsg[]
    expect(second.some((x) => x.type === "system")).toBe(false)
  })

  it("streams text as message_start + content_block_delta frames (no snapshot per delta)", () => {
    const m = createSdkEventMapper(ctx)
    const first = m.handle({ type: "text-delta", text: "Hel" }) as AnyMsg[]
    // The delta path emits incremental stream frames, not a full assistant snapshot.
    expect(first.some((x) => x.type === "assistant")).toBe(false)
    const kinds = first.map((x) => x.event?.type).filter(Boolean)
    expect(kinds).toContain("message_start")
    expect(kinds).toContain("content_block_delta")
    const delta = first.find((x) => x.event?.type === "content_block_delta")!.event!.delta
    expect(delta).toEqual({ type: "text_delta", text: "Hel" })
    // A second delta emits only content_block_delta — message_start is once-per-id.
    const second = m.handle({ type: "text-delta", text: "lo" }) as AnyMsg[]
    expect(second.every((x) => x.type === "stream_event")).toBe(true)
    expect(second.some((x) => x.event?.type === "message_start")).toBe(false)
  })

  it("reasoning streams as thinking_delta content_block_delta frames", () => {
    const m = createSdkEventMapper(ctx)
    const out = m.handle({ type: "reasoning-delta", text: "hmm" }) as AnyMsg[]
    const delta = out.find((x) => x.event?.type === "content_block_delta")!.event!.delta
    expect(delta).toEqual({ type: "thinking_delta", thinking: "hmm" })
  })

  it("sealAssistant() returns [] when nothing is buffered", () => {
    const m = createSdkEventMapper(ctx)
    expect(m.sealAssistant()).toEqual([])
  })

  it("accumulates text-delta and seals one assistant text block with a stable id", () => {
    const m = createSdkEventMapper(ctx)
    const start = m.handle({ type: "text-delta", text: "Hello" }) as AnyMsg[]
    const streamId = start.find((x) => x.event?.type === "message_start")!.event!.message!.id
    m.handle({ type: "text-delta", text: ", world" })
    const asst = (m.sealAssistant() as AnyMsg[]).find((x) => x.type === "assistant")!
    expect(asst.message?.content?.[0]).toEqual({ type: "text", text: "Hello, world" })
    // The sealed snapshot shares the streamed message_start id (replace-by-id).
    expect(asst.message!.id).toBe(streamId)
    // id stays stable across further deltas within the same block
    m.handle({ type: "text-delta", text: "!" })
    const asst2 = (m.sealAssistant() as AnyMsg[]).find((x) => x.type === "assistant")!
    expect(asst2.message!.id).toBe(asst.message!.id)
  })

  it("maps reasoning-delta to a thinking block once sealed", () => {
    const m = createSdkEventMapper(ctx)
    m.handle({ type: "reasoning-delta", text: "thinking…" })
    expect(assistantContent(m.sealAssistant() as AnyMsg[])).toContainEqual({
      type: "thinking",
      thinking: "thinking…",
    })
  })

  it("maps tool-call to a tool_use block and starts a fresh text block after it", () => {
    const m = createSdkEventMapper(ctx)
    m.handle({ type: "text-delta", text: "before" })
    const callOut = m.handle({
      type: "tool-call",
      toolCallId: "tc1",
      toolName: "web_search",
      args: { q: "x" },
    }) as AnyMsg[]
    expect(assistantContent(callOut)).toContainEqual({
      type: "tool_use",
      id: "tc1",
      name: "web_search",
      input: { q: "x" },
    })
    // text after a tool_use gets a new message id (boundary change)
    const beforeId = callOut.find((x) => x.type === "assistant")!.message!.id
    const afterText = m.handle({ type: "text-delta", text: "after" }) as AnyMsg[]
    // The boundary text-delta re-seeds the stream with a fresh message_start id.
    expect(afterText.find((x) => x.event?.type === "message_start")!.event!.message!.id).not.toBe(
      beforeId
    )
    expect(
      (m.sealAssistant() as AnyMsg[]).find((x) => x.type === "assistant")!.message!.id
    ).not.toBe(beforeId)
  })

  it("maps tool-result to a synthetic user tool_result message (v6 `output`)", () => {
    const m = createSdkEventMapper(ctx)
    const out = m.handle({ type: "tool-result", toolCallId: "tc1", output: "done" }) as AnyMsg[]
    const user = out.find((x) => x.type === "user")!
    expect(user.message?.content?.[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tc1",
      content: "done",
      is_error: false,
    })
  })

  it("maps tool-error to an errored tool_result", () => {
    const m = createSdkEventMapper(ctx)
    const out = m.handle({
      type: "tool-error",
      toolCallId: "tc1",
      error: new Error("boom"),
    }) as AnyMsg[]
    expect(out.find((x) => x.type === "user")!.message?.content?.[0]).toMatchObject({
      type: "tool_result",
      content: "boom",
      is_error: true,
    })
  })

  it("projects a source-url part as a deduped citation on the text block", () => {
    const m = createSdkEventMapper(ctx)
    m.handle({ type: "text-delta", text: "answer" })
    m.handle({ type: "source-url", url: "https://a.com", title: "A" })
    const out = m.handle({ type: "source-url", url: "https://a.com", title: "A" }) as AnyMsg[]
    const textBlock = assistantContent(out).find((b) => b.type === "text")!
    expect(textBlock.citations).toEqual([
      { type: "url_citation", url: "https://a.com", title: "A" },
    ])
  })

  it("finish() emits a result message mapping usage fields", () => {
    const m = createSdkEventMapper(ctx)
    m.handle({ type: "text-delta", text: "x" })
    m.handle({
      type: "finish",
      usage: { promptTokens: 10, completionTokens: 5, reasoningTokens: 2 },
    })
    const out = m.finish() as AnyMsg[]
    const result = out.find((x) => x.type === "result")!
    expect(result).toMatchObject({ subtype: "success", num_turns: 1 })
    expect(result.usage).toMatchObject({
      input_tokens: 10,
      output_tokens: 5,
      reasoning_tokens: 2,
    })
  })

  it("setModel updates subsequent assistant snapshots", () => {
    const m = createSdkEventMapper(ctx)
    m.setModel("gpt-5")
    m.handle({ type: "text-delta", text: "y" })
    const out = m.sealAssistant() as AnyMsg[]
    expect((out.find((x) => x.type === "assistant")!.message as { model?: string }).model).toBe(
      "gpt-5"
    )
  })

  it("ignores unknown / error events without throwing", () => {
    const m = createSdkEventMapper(ctx)
    expect(m.handle({ type: "error", error: "nope" })).toEqual([
      expect.objectContaining({ type: "system" }),
    ])
    expect(m.handle({ type: "totally-unknown" })).toEqual([])
    expect(m.handle(undefined)).toEqual([])
  })

  it("accepts v4 `textDelta` and low-level `delta` field names", () => {
    const m = createSdkEventMapper(ctx)
    m.handle({ type: "text-delta", textDelta: "a" })
    m.handle({ type: "text-delta", delta: "b" })
    const out = m.sealAssistant() as AnyMsg[]
    expect(assistantContent(out)[0]).toEqual({ type: "text", text: "ab" })
  })

  it("maps reasoning deltas from textDelta/delta too", () => {
    const m = createSdkEventMapper(ctx)
    m.handle({ type: "reasoning", textDelta: "r" })
    expect(assistantContent(m.sealAssistant() as AnyMsg[])).toContainEqual({
      type: "thinking",
      thinking: "r",
    })
  })

  it("defaults tool-call id/name/input when missing", () => {
    const m = createSdkEventMapper(ctx)
    const out = m.handle({ type: "tool-call" }) as AnyMsg[]
    const tu = assistantContent(out).find((b) => b.type === "tool_use")!
    expect(tu).toMatchObject({ name: "unknown", input: {} })
    expect(typeof tu.id).toBe("string")
  })

  it("projects a source-document part as a document citation", () => {
    const m = createSdkEventMapper(ctx)
    m.handle({ type: "text-delta", text: "x" })
    const out = m.handle({ type: "source-document", title: "Spec.pdf" }) as AnyMsg[]
    const textBlock = assistantContent(out).find((b) => b.type === "text")!
    expect(textBlock.citations).toEqual([
      { type: "document", document_title: "Spec.pdf", title: "Spec.pdf" },
    ])
  })

  it("ignores a source part with neither url nor title", () => {
    const m = createSdkEventMapper(ctx)
    m.handle({ type: "text-delta", text: "x" })
    const out = m.handle({ type: "source-url" }) as AnyMsg[]
    const textBlock = assistantContent(out).find((b) => b.type === "text")!
    expect(textBlock.citations).toBeUndefined()
  })

  it("maps v6 inputTokens/outputTokens and cache/context fields in finish()", () => {
    const m = createSdkEventMapper(ctx)
    const out = m.finish({
      usage: {
        inputTokens: 4,
        outputTokens: 6,
        contextInputTokens: 3,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 1,
      },
      totalCostUsd: 0.01,
    }) as AnyMsg[]
    expect((out[0] as AnyMsg).type).toBe("system") // init emitted once
    const result = out.find((x) => x.type === "result")!
    expect(result.usage).toMatchObject({
      input_tokens: 4,
      output_tokens: 6,
      context_input_tokens: 3,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1,
    })
  })

  it("uses `filename` as the citation title when `title` is absent", () => {
    const m = createSdkEventMapper(ctx)
    m.handle({ type: "text-delta", text: "x" })
    const out = m.handle({
      type: "source-url",
      url: "https://f.com",
      filename: "f.pdf",
    }) as AnyMsg[]
    const textBlock = assistantContent(out).find((b) => b.type === "text")!
    expect(textBlock.citations).toEqual([
      { type: "url_citation", url: "https://f.com", title: "f.pdf" },
    ])
  })

  it("drops a source-document with no title and a sourceType-less source", () => {
    const m = createSdkEventMapper(ctx)
    m.handle({ type: "text-delta", text: "x" })
    m.handle({ type: "source-document" })
    const out = m.handle({ type: "source", sourceType: "other" }) as AnyMsg[]
    const textBlock = assistantContent(out).find((b) => b.type === "text")!
    expect(textBlock.citations).toBeUndefined()
  })

  it("maps a string tool-error and a structured tool-error", () => {
    const m1 = createSdkEventMapper(ctx)
    expect(
      (m1.handle({ type: "tool-error", toolCallId: "t", error: "plain" }) as AnyMsg[]).find(
        (x) => x.type === "user"
      )!.message?.content?.[0]
    ).toMatchObject({ content: "plain", is_error: true })
    const m2 = createSdkEventMapper(ctx)
    expect(
      (m2.handle({ type: "tool-error", toolCallId: "t", error: { code: 9 } }) as AnyMsg[]).find(
        (x) => x.type === "user"
      )!.message?.content?.[0]
    ).toMatchObject({ content: JSON.stringify({ code: 9 }), is_error: true })
  })

  it("reads the v4 `result` field for tool-result payloads", () => {
    const m = createSdkEventMapper(ctx)
    const out = m.handle({ type: "tool-result", toolCallId: "t", result: "v4out" }) as AnyMsg[]
    expect(out.find((x) => x.type === "user")!.message?.content?.[0]).toMatchObject({
      content: "v4out",
    })
  })

  it("reset() prevents turn N text from bleeding into turn N+1 (duplicate-output guard)", () => {
    const m = createSdkEventMapper(ctx)
    m.handle({ type: "text-delta", text: "turn-one" })
    m.finish()
    m.reset()
    m.handle({ type: "text-delta", text: "turn-two" })
    const textBlock = assistantContent(m.sealAssistant() as AnyMsg[]).find(
      (b) => b.type === "text"
    )!
    expect(textBlock.text).toBe("turn-two")
  })
})
