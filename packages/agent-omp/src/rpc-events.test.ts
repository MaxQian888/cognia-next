import { createOmpStreamState, mapOmpRpcEvent, ompStatsToTokenUsage } from "./rpc-events"

describe("OMP canonical events", () => {
  const now = () => new Date("2026-10-06T00:00:00Z")
  const context = () => ({ sessionId: "s", now, streamState: createOmpStreamState() })
  it("maps reasoning into the canonical delta consumed by execute exactly once", () => {
    const observed = jest.fn()
    const event = {
      type: "message_update",
      messageId: "m",
      assistantMessageEvent: { type: "thinking_delta", delta: "reasoning" },
    }
    expect(mapOmpRpcEvent(event, { ...context(), onNativeEvent: observed })).toEqual([
      {
        sessionId: "s",
        timestamp: now(),
        messageId: "m",
        type: "message_delta",
        delta: { type: "thinking", text: "reasoning" },
      },
    ])
    expect(observed).toHaveBeenCalledWith(event)
  })
  it("projects builtin command output and title updates", () => {
    expect(mapOmpRpcEvent({ type: "command_output", text: "ready" }, context())[0]).toMatchObject({
      type: "message_delta",
      delta: { text: "ready" },
    })
    expect(
      mapOmpRpcEvent({ type: "session_info_update", title: "New name" }, context())[0]
    ).toMatchObject({ type: "session_info_update", title: "New name" })
  })
  it("never settles a prompt from lifecycle events", () => {
    for (const type of ["agent_end", "turn_end", "prompt_result", "session_settled"]) {
      expect(mapOmpRpcEvent({ type }, context()).some((e) => e.type === "done")).toBe(false)
    }
  })
  it("keeps message identities when injected messages interrupt a streaming reply", () => {
    const ctx = context()
    mapOmpRpcEvent(
      { type: "message_start", messageId: "reply", message: { role: "assistant" } },
      ctx
    )
    mapOmpRpcEvent(
      { type: "message_start", messageId: "injected", message: { role: "user", content: "hello" } },
      ctx
    )
    expect(
      mapOmpRpcEvent(
        {
          type: "message_update",
          messageId: "reply",
          assistantMessageEvent: { type: "text_delta", delta: "ok" },
        },
        ctx
      )[0]
    ).toMatchObject({ type: "message_delta", messageId: "reply", delta: { text: "ok" } })
  })
  it("resolves tool ids from full partial snapshots and deduplicates execution starts", () => {
    const ctx = context()
    const partial = { content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }] }
    expect(
      mapOmpRpcEvent(
        {
          type: "message_update",
          messageId: "m",
          assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial },
        },
        ctx
      )[0]
    ).toMatchObject({ type: "tool_use_start", toolUseId: "t1" })
    expect(
      mapOmpRpcEvent(
        {
          type: "message_update",
          messageId: "m",
          assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "{}" },
        },
        ctx
      )[0]
    ).toMatchObject({ type: "tool_use_delta", toolUseId: "t1" })
    expect(
      mapOmpRpcEvent(
        { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} },
        ctx
      )[0].type
    ).toBe("tool_call_update")
    expect(
      mapOmpRpcEvent(
        {
          type: "tool_execution_update",
          toolCallId: "t1",
          partialResult: { content: [{ type: "text", text: "snapshot" }] },
        },
        ctx
      )[0]
    ).toMatchObject({
      type: "tool_call_update",
      rawOutput: { content: [{ text: "snapshot", type: "text" }] },
    })
  })
  it("creates an identified tool before ending its arguments in delta-only mode", () => {
    const ctx = context()
    expect(
      mapOmpRpcEvent(
        {
          type: "message_update",
          messageId: "m",
          assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 },
        },
        ctx
      )
    ).toEqual([])
    const end = mapOmpRpcEvent(
      {
        type: "message_update",
        messageId: "m",
        assistantMessageEvent: {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: { id: "t", name: "read", arguments: { path: "file" } },
        },
      },
      ctx
    )
    expect(end.map((event) => event.type)).toEqual(["tool_use_start", "tool_use_end"])
    expect(
      mapOmpRpcEvent(
        { type: "tool_execution_start", toolCallId: "t", toolName: "read", args: {} },
        ctx
      )[0].type
    ).toBe("tool_call_update")
  })
  it("retains images and usage and surfaces provider rejection", () => {
    const ctx = context()
    const user = mapOmpRpcEvent(
      {
        type: "message_start",
        messageId: "u",
        message: { role: "user", content: [{ type: "image", mimeType: "image/png", data: "abc" }] },
      },
      ctx
    )
    expect(user[1]).toMatchObject({
      type: "content_block_start",
      role: "user",
      block: { type: "image", data: "abc" },
    })
    const end = mapOmpRpcEvent(
      {
        type: "message_end",
        messageId: "m",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "denied",
          usage: {
            input: 2,
            output: 3,
            cacheRead: 4,
            cacheWrite: 1,
            totalTokens: 10,
            cost: { total: 0.2 },
          },
        },
      },
      ctx
    )
    expect(end[0]).toMatchObject({ type: "error", error: "denied" })
    expect(end.at(-1)).toMatchObject({
      type: "message_end",
      tokenUsage: { totalTokens: 10, providerCost: { amount: 0.2 } },
    })
    expect(
      ompStatsToTokenUsage({ tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } })
        ?.totalTokens
    ).toBe(10)
  })
  it("preserves native events without turning subagent text into parent text", () => {
    const observe = jest.fn()
    const frame = { type: "subagent_event", subagentId: "child", event: { type: "message_update" } }
    expect(mapOmpRpcEvent(frame, { ...context(), onNativeEvent: observe })).toEqual([])
    expect(observe).toHaveBeenCalledWith(frame)
  })
  it("maps dialogs and cancellation with a preserved raw response contract", () => {
    const ctx = context()
    expect(
      mapOmpRpcEvent(
        {
          type: "extension_ui_request",
          id: "q",
          method: "input",
          title: "Name",
          placeholder: "hint",
        },
        ctx
      )[0]
    ).toMatchObject({
      type: "elicitation_request",
      request: {
        id: "q",
        requestedSchema: { properties: { input: { description: "hint" } } },
        raw: { method: "input" },
      },
    })
    expect(
      mapOmpRpcEvent({ type: "extension_ui_request", method: "cancel", targetId: "q" }, ctx)[0]
    ).toMatchObject({ type: "elicitation_complete", elicitationId: "q" })
    expect(
      mapOmpRpcEvent(
        {
          type: "extension_ui_request",
          method: "setStatus",
          statusKey: "cognia-omp-ready",
          statusText: "nonce",
        },
        ctx
      )
    ).toEqual([])
  })
  it("maps ask selections and optional custom input without losing multi-select semantics", () => {
    const events = mapOmpRpcEvent(
      {
        type: "extension_ui_request",
        id: "q",
        method: "ask",
        questions: [
          {
            id: "db",
            question: "Database?",
            multi: true,
            options: [{ label: "A" }, { label: "B" }],
          },
        ],
      },
      context()
    )
    expect(events[0]).toMatchObject({
      type: "elicitation_request",
      request: {
        requestedSchema: {
          properties: {
            db: { type: "array", items: { enum: ["A", "B"] } },
            "db:customInput": { type: "string" },
          },
        },
      },
    })
  })
})
