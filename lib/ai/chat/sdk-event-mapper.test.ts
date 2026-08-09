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
  message?: {
    id?: string
    content?: Array<Record<string, unknown>>
    role?: string
    metadata?: unknown
  }
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

  it("maps AI SDK step boundaries to stream events", () => {
    const m = createSdkEventMapper(ctx)
    const start = m.handle({ type: "start-step" }) as AnyMsg[]
    expect(start.map((x) => x.event?.type).filter(Boolean)).toEqual(["message_start", "step_start"])

    const finish = m.handle({ type: "finish-step" }) as AnyMsg[]
    expect(finish.map((x) => x.event?.type).filter(Boolean)).toEqual(["step_finish"])
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

  it("uses the AI SDK start.messageId for streamed and sealed assistant ids", () => {
    const m = createSdkEventMapper(ctx)
    m.handle({ type: "start", messageId: "sdk-message-1" })
    const start = m.handle({ type: "text-delta", text: "Hello" }) as AnyMsg[]
    expect(start.find((x) => x.event?.type === "message_start")!.event!.message!.id).toBe(
      "sdk-message-1"
    )
    const asst = (m.sealAssistant() as AnyMsg[]).find((x) => x.type === "assistant")!
    expect(asst.message!.id).toBe("sdk-message-1")
  })

  it("preserves start, message-metadata, and finish messageMetadata on the sealed assistant", () => {
    const m = createSdkEventMapper(ctx)
    m.handle({
      type: "start",
      messageId: "sdk-message-1",
      messageMetadata: { phase: "start" },
    })
    m.handle({ type: "text-delta", text: "Hello" })
    m.handle({ type: "message-metadata", messageMetadata: { phase: "mid" } })
    m.handle({
      type: "finish",
      finishReason: "stop",
      messageMetadata: { phase: "finish" },
    })
    const asst = (m.sealAssistant() as AnyMsg[]).find((x) => x.type === "assistant")!
    expect(asst.message).toMatchObject({
      id: "sdk-message-1",
      metadata: { phase: "finish" },
    })
  })

  it("deep-merges non-null messageMetadata updates like AI SDK UI streams", () => {
    const m = createSdkEventMapper(ctx)
    m.handle({
      type: "start",
      messageMetadata: {
        phase: "start",
        nested: { keep: true, replace: "start" },
        list: ["start"],
      },
    })
    m.handle({
      type: "message-metadata",
      messageMetadata: {
        nested: { replace: "mid", add: 1 },
        list: ["mid"],
        unsafe: "kept",
      },
    })
    m.handle({ type: "message-metadata", messageMetadata: null })
    m.handle({ type: "message-metadata", messageMetadata: undefined })
    m.handle({ type: "text-delta", text: "Hello" })
    m.handle({
      type: "finish",
      messageMetadata: {
        phase: "finish",
        nested: { add: 2 },
        __proto__: { polluted: true },
      },
    })

    const asst = (m.sealAssistant() as AnyMsg[]).find((x) => x.type === "assistant")!
    expect(asst.message!.metadata).toEqual({
      phase: "finish",
      nested: { keep: true, replace: "mid", add: 2 },
      list: ["mid"],
      unsafe: "kept",
    })
    expect(Object.prototype).not.toHaveProperty("polluted")
  })

  it("preserves the latest provider metadata on sealed text blocks", () => {
    const m = createSdkEventMapper(ctx)
    m.handle({
      type: "text-delta",
      text: "Hello",
      providerMetadata: { provider: { phase: "start" } },
    })
    m.handle({
      type: "text-delta",
      text: " world",
      providerMetadata: { provider: { phase: "final" } },
    })
    expect(assistantContent(m.sealAssistant() as AnyMsg[])[0]).toEqual({
      type: "text",
      text: "Hello world",
      providerMetadata: { provider: { phase: "final" } },
    })
  })

  it("uses text-start and text-end provider metadata when sealing text blocks", () => {
    const m = createSdkEventMapper(ctx)
    m.handle({
      type: "text-start",
      id: "text-1",
      providerMetadata: { provider: { phase: "start" } },
    })
    m.handle({ type: "text-delta", id: "text-1", text: "Hello" })
    m.handle({
      type: "text-end",
      id: "text-1",
      providerMetadata: { provider: { phase: "end" } },
    })
    expect(assistantContent(m.sealAssistant() as AnyMsg[])[0]).toEqual({
      type: "text",
      text: "Hello",
      providerMetadata: { provider: { phase: "end" } },
    })
  })

  it("maps reasoning-delta to a thinking block once sealed", () => {
    const m = createSdkEventMapper(ctx)
    m.handle({ type: "reasoning-delta", text: "thinking…" })
    expect(assistantContent(m.sealAssistant() as AnyMsg[])).toContainEqual({
      type: "thinking",
      thinking: "thinking…",
    })
  })

  it("drops reasoning explicitly marked as raw analysis before rendering or sealing", () => {
    const m = createSdkEventMapper({ ...ctx, model: "openai/gpt-oss-20b" })
    const metadata = { cognia: { reasoningSource: "raw-analysis" } }
    const streamed = m.handle({
      type: "reasoning-delta",
      text: "private chain of thought",
      providerMetadata: metadata,
    }) as AnyMsg[]

    expect(streamed.some((item) => item.event?.type === "content_block_delta")).toBe(false)
    expect(m.sealAssistant()).toEqual([])
    expect(JSON.stringify(streamed)).not.toContain("private chain of thought")
  })

  it("preserves the latest provider metadata on sealed reasoning blocks", () => {
    const m = createSdkEventMapper(ctx)
    m.handle({
      type: "reasoning-delta",
      text: "first ",
      providerMetadata: { provider: { phase: "start" } },
    })
    m.handle({
      type: "reasoning-delta",
      text: "second",
      providerMetadata: { provider: { phase: "final" } },
    })
    expect(assistantContent(m.sealAssistant() as AnyMsg[])).toContainEqual({
      type: "thinking",
      thinking: "first second",
      providerMetadata: { provider: { phase: "final" } },
    })
  })

  it("uses reasoning-start and reasoning-end provider metadata when sealing thinking blocks", () => {
    const m = createSdkEventMapper(ctx)
    m.handle({
      type: "reasoning-start",
      id: "reasoning-1",
      providerMetadata: { provider: { phase: "start" } },
    })
    m.handle({ type: "reasoning-delta", id: "reasoning-1", text: "thinking" })
    m.handle({
      type: "reasoning-end",
      id: "reasoning-1",
      providerMetadata: { provider: { phase: "end" } },
    })
    expect(assistantContent(m.sealAssistant() as AnyMsg[])).toContainEqual({
      type: "thinking",
      thinking: "thinking",
      providerMetadata: { provider: { phase: "end" } },
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

  it("maps tool-output-denied to an errored tool_result for the denied call", () => {
    const m = createSdkEventMapper(ctx)
    m.handle({
      type: "tool-call",
      toolCallId: "tc-denied",
      toolName: "write",
      args: { path: "secret.txt" },
    })
    const out = m.handle({
      type: "tool-output-denied",
      toolCallId: "tc-denied",
      toolName: "write",
    }) as AnyMsg[]
    expect(out.find((x) => x.type === "user")!.message?.content?.[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tc-denied",
      is_error: true,
    })
    const content = out.find((x) => x.type === "user")!.message?.content?.[0].content
    expect(content).toEqual(expect.stringContaining("write"))
    expect(content).toEqual(expect.stringMatching(/denied/i))
  })

  it("drops a v7 reasoning-file part without rendering or persisting it", () => {
    // AI SDK 7 split files referenced inside a model's reasoning trace out of
    // `file` into `reasoning-file`. Raw chain-of-thought artifacts must never
    // reach the transcript, so this part is dropped on purpose — asserted here
    // so a future "handle every part type" pass can't quietly start showing
    // them. Mirrors the sidecar event-adapter test of the same name.
    const m = createSdkEventMapper(ctx)
    m.handle({ type: "start" } as never)
    const out = m.handle({
      type: "reasoning-file",
      file: { base64: "U0VDUkVU", mediaType: "image/png" },
      filename: "scratchpad.png",
    } as never) as AnyMsg[]

    expect(out).toEqual([])
    expect(m.sealAssistant()).toEqual([])

    // A genuine output file on the same turn is unaffected.
    const after = m.handle({
      type: "file",
      file: { base64: "QUJD", mediaType: "image/png" },
      filename: "chart.png",
    }) as AnyMsg[]
    expect(assistantContent(after)).toEqual([
      {
        type: "file",
        source: { type: "base64", media_type: "image/png", data: "QUJD" },
        filename: "chart.png",
      },
    ])
  })

  it("emits a generated file part as its own one-shot assistant message", () => {
    const m = createSdkEventMapper(ctx)
    const out = m.handle({
      type: "file",
      file: { base64: "QUJD", mediaType: "image/png" },
      filename: "chart.png",
    }) as AnyMsg[]
    expect(assistantContent(out)).toEqual([
      {
        type: "file",
        source: { type: "base64", media_type: "image/png", data: "QUJD" },
        filename: "chart.png",
      },
    ])
    // The base64 payload crosses the pipe exactly once: later snapshots do
    // NOT re-embed it (the previous accumulate-into-every-snapshot behavior
    // was O(N²) bytes over the wire).
    expect(m.sealAssistant()).toEqual([])
    m.handle({ type: "text-delta", text: "done" })
    expect(assistantContent(m.sealAssistant() as AnyMsg[])).toEqual([
      { type: "text", text: "done" },
    ])
  })

  it("maps a url file part onto a one-shot assistant message", () => {
    const m = createSdkEventMapper(ctx)
    const out = m.handle({
      type: "file",
      url: "https://files.example/chart.png",
      mediaType: "image/png",
    }) as AnyMsg[]
    expect(assistantContent(out)).toEqual([
      {
        type: "file",
        url: "https://files.example/chart.png",
        media_type: "image/png",
      },
    ])
  })

  it("maps streamed tool input to one pending tool_use block then finalizes it", () => {
    const m = createSdkEventMapper(ctx)
    const started = m.handle({
      type: "tool-input-start",
      id: "tc-stream",
      toolName: "write",
    }) as AnyMsg[]
    expect(assistantContent(started).find((b) => b.type === "tool_use")).toEqual({
      type: "tool_use",
      id: "tc-stream",
      name: "write",
      input: {},
      state: "input-streaming",
    })

    // Deltas accumulate silently — no whole-buffer re-parse and no full
    // assistant snapshot per chunk (the O(n²) fix). Split the JSON across two
    // deltas to prove reassembly happens once, at tool-input-end.
    const delta1 = m.handle({
      type: "tool-input-delta",
      id: "tc-stream",
      delta: '{"path":"secr',
    }) as AnyMsg[]
    const delta2 = m.handle({
      type: "tool-input-delta",
      id: "tc-stream",
      delta: 'et.txt"}',
    }) as AnyMsg[]
    expect(delta1.find((msg) => msg.type === "assistant")).toBeUndefined()
    expect(delta2.find((msg) => msg.type === "assistant")).toBeUndefined()

    // tool-input-end finalizes the input: the transient "input-streaming"
    // state is dropped so the block never sticks in-flight when no
    // tool-call / tool-input-available follows.
    const ended = m.handle({ type: "tool-input-end", id: "tc-stream" }) as AnyMsg[]
    expect(assistantContent(ended).find((b) => b.type === "tool_use")).toEqual({
      type: "tool_use",
      id: "tc-stream",
      name: "write",
      input: { path: "secret.txt" },
    })

    const final = m.handle({
      type: "tool-call",
      toolCallId: "tc-stream",
      toolName: "write",
      input: { path: "final.txt" },
      providerExecuted: false,
      providerMetadata: { provider: { traceId: "trace-tool" } },
      toolMetadata: { display: "Write file" },
      dynamic: false,
      title: "Write file",
    }) as AnyMsg[]
    expect(assistantContent(final).filter((b) => b.type === "tool_use")).toEqual([
      {
        type: "tool_use",
        id: "tc-stream",
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

  it("maps tool-approval-request to an approval-requested tool_use block", () => {
    const m = createSdkEventMapper(ctx)
    m.handle({
      type: "tool-call",
      toolCallId: "tc-approval",
      toolName: "write",
      input: { path: "secret.txt" },
    })
    const out = m.handle({
      type: "tool-approval-request",
      approvalId: "approval-1",
      signature: "sig-1",
      toolCall: {
        type: "tool-call",
        toolCallId: "tc-approval",
        toolName: "write",
        input: { path: "secret.txt" },
      },
    }) as AnyMsg[]
    expect(assistantContent(out).filter((b) => b.type === "tool_use")).toEqual([
      {
        type: "tool_use",
        id: "tc-approval",
        name: "write",
        input: { path: "secret.txt" },
        state: "approval-requested",
        approval: { id: "approval-1", signature: "sig-1" },
      },
    ])
  })

  it("maps nested toolCall metadata from tool-approval-request", () => {
    const m = createSdkEventMapper(ctx)
    const out = m.handle({
      type: "tool-approval-request",
      approvalId: "approval-meta",
      toolCall: {
        type: "tool-call",
        toolCallId: "tc-approval-meta",
        toolName: "write",
        input: { path: "secret.txt" },
        providerExecuted: false,
        providerMetadata: { provider: { traceId: "trace-approval" } },
        toolMetadata: { display: "Write file" },
        dynamic: false,
        title: "Write file",
      },
    }) as AnyMsg[]
    expect(assistantContent(out).filter((b) => b.type === "tool_use")).toEqual([
      {
        type: "tool_use",
        id: "tc-approval-meta",
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

  it("maps UI-message tool-input-available to a finalized tool_use block", () => {
    const m = createSdkEventMapper(ctx)
    const out = m.handle({
      type: "tool-input-available",
      toolCallId: "tc-input-ready",
      toolName: "write",
      input: { path: "ready.txt" },
      providerExecuted: false,
      providerMetadata: { provider: { traceId: "trace-ready" } },
      toolMetadata: { display: "Write file" },
      dynamic: true,
      title: "Write file",
    }) as AnyMsg[]

    expect(assistantContent(out).filter((b) => b.type === "tool_use")).toEqual([
      {
        type: "tool_use",
        id: "tc-input-ready",
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

  it("maps UI-message tool output and input errors to tool_result messages", () => {
    const m = createSdkEventMapper(ctx)
    m.handle({
      type: "tool-input-available",
      toolCallId: "tc-output",
      toolName: "write",
      input: { path: "ready.txt" },
    })

    const available = m.handle({
      type: "tool-output-available",
      toolCallId: "tc-output",
      output: { ok: true },
    }) as AnyMsg[]
    expect(available.find((x) => x.type === "user")!.message?.content?.[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tc-output",
      content: JSON.stringify({ ok: true }),
      is_error: false,
    })

    const outputError = m.handle({
      type: "tool-output-error",
      toolCallId: "tc-output",
      errorText: "write failed",
    }) as AnyMsg[]
    expect(outputError.find((x) => x.type === "user")!.message?.content?.[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tc-output",
      content: "write failed",
      is_error: true,
    })

    const inputError = m.handle({
      type: "tool-input-error",
      toolCallId: "tc-input-error",
      toolName: "write",
      input: { path: "bad.txt" },
      errorText: "invalid input",
    }) as AnyMsg[]
    expect(inputError.find((x) => x.type === "user")!.message?.content?.[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tc-input-error",
      content: "invalid input",
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

  it("maps AI SDK finish.totalUsage when the finish stream part is handled directly", () => {
    const m = createSdkEventMapper(ctx)
    m.handle({ type: "text-delta", text: "x" })
    m.handle({
      type: "finish",
      totalUsage: { inputTokens: 8, outputTokens: 3, reasoningTokens: 1 },
    })
    const out = m.finish() as AnyMsg[]
    const result = out.find((x) => x.type === "result")!
    expect(result.usage).toMatchObject({
      input_tokens: 8,
      output_tokens: 3,
      reasoning_tokens: 1,
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

  it("ignores raw provider frames without rendering or sealing them", () => {
    const m = createSdkEventMapper(ctx)
    expect(m.handle({ type: "raw", rawValue: { vendor: "frame" } })).toEqual([
      expect.objectContaining({ type: "system" }),
    ])
    expect(m.sealAssistant()).toEqual([])
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

  it("dedupes source-document parts by title", () => {
    const m = createSdkEventMapper(ctx)
    m.handle({ type: "text-delta", text: "x" })
    m.handle({ type: "source-document", id: "d1", title: "Spec.pdf" })
    const out = m.handle({ type: "source-document", id: "d2", title: "Spec.pdf" }) as AnyMsg[]
    const textBlock = assistantContent(out).find((b) => b.type === "text")!
    expect((textBlock.citations as unknown[]).length).toBe(1)
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

  it("maps exact AI SDK LanguageModelUsage nested token details in finish()", () => {
    const m = createSdkEventMapper(ctx)
    const out = m.finish({
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
    }) as AnyMsg[]
    const result = out.find((x) => x.type === "result")!
    expect(result.usage).toMatchObject({
      cache_read_input_tokens: 4,
      cache_creation_input_tokens: 2,
      reasoning_tokens: 3,
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
