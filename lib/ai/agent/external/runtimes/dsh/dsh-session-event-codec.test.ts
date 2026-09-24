import {
  dshEventDedupeKey,
  DshVersionDriftError,
  translateDshNotification,
  translateDshNotifications,
} from "./dsh-session-event-codec"

const frame = (type: string, data: unknown, extra = {}) => ({
  method: "session.event",
  params: { sessionId: "s", event: { type, data, seq: 1, time: 1234, ...extra } },
})
const assistant = (content: unknown[], usage?: unknown) =>
  frame("assistant/message", { message: { id: "a", content }, usage, stream: [] })

describe("current DeepSeek Harness session format 3", () => {
  it("emits committed text and governed reasoning exactly once without replaying the embedded stream", () => {
    const result = translateDshNotification(
      frame("assistant/message", {
        message: {
          id: "a",
          content: [
            { type: "text", text: "answer" },
            { type: "reasoning", text: "thought" },
            { type: "tool-call", id: "c", name: "read", arguments: "{}" },
          ],
        },
        stream: [{ type: "text-chunks", texts: ["answer"], dt: [0], time0: 1234, index: 0 }],
      })
    )
    expect(result.events.map((event) => event.type)).toEqual([
      "message_start",
      "message_delta",
      "thinking",
      "message_end",
    ])
    expect(result.events[1]).toMatchObject({
      messageId: "a",
      delta: { type: "text", text: "answer" },
      timestamp: new Date(1234),
    })
  })
  it("includes cache input in totals and preserves provider totals and reasoning", () => {
    const events = translateDshNotification(
      assistant([], {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 20,
        cacheWriteTokens: 3,
        reasoningTokens: 2,
        totalTokens: 38,
      })
    ).events
    expect(events.at(-1)).toMatchObject({
      tokenUsage: {
        promptTokens: 33,
        completionTokens: 5,
        totalTokens: 38,
        cacheReadTokens: 20,
        cacheWriteTokens: 3,
        reasoningTokens: 2,
      },
    })
    expect(
      translateDshNotification(assistant([], { inputTokens: 2, outputTokens: 3 })).events.at(-1)
    ).toMatchObject({ tokenUsage: { totalTokens: 5 } })
  })
  it("does not fabricate accounting when the provider omitted it", () => {
    expect(translateDshNotification(assistant([])).events.at(-1)).toMatchObject({
      tokenUsage: undefined,
    })
  })
  it.each([
    ["completed", true, "end_turn"],
    ["aborted", false, "cancelled"],
    ["interrupted", false, "cancelled"],
    ["blocked", false, "refusal"],
    ["max-tokens", false, "max_tokens"],
  ])("maps terminal reason %s", (kind, success, stopReason) => {
    expect(translateDshNotification(frame("turn/end", { reason: { kind } })).events).toEqual([
      expect.objectContaining({ type: "done", success, stopReason }),
    ])
  })
  it("carries a structured provider failure before the failed terminal verdict", () => {
    expect(
      translateDshNotification(
        frame("turn/end", { reason: { kind: "error", error: { code: "AUTH", message: "denied" } } })
      ).events
    ).toMatchObject([
      { type: "error", error: "denied", code: "AUTH" },
      { type: "done", success: false },
    ])
  })
  it("never converts an idle status into success", () => {
    expect(
      translateDshNotification({
        method: "session.status",
        params: { sessionId: "s", status: "idle" },
      }).events
    ).toEqual([])
  })
  it("retains exact tool input and does not duplicate tool invocations", () => {
    const events = translateDshNotification(
      frame("tool/call", { callId: "c", name: "read", arguments: '{"path":"a"}' })
    ).events
    expect(events).toMatchObject([
      { type: "tool_use_start", toolUseId: "c", rawInput: { path: "a" } },
      { type: "tool_use_delta", delta: '{"path":"a"}' },
      { type: "tool_use_end", input: { path: "a" } },
    ])
  })
  it("preserves malformed model arguments while warning", () => {
    const result = translateDshNotification(
      frame("tool/call", { callId: "c", name: "read", arguments: "{" })
    )
    expect(result.events[1]).toMatchObject({ delta: "{" })
    expect(result.warnings[0].kind).toBe("malformed-payload")
  })
  it("keeps all tool result blocks and tool-private metadata", () => {
    const content = [
      { type: "text", text: "ok" },
      { type: "image", attachment: { id: "image" } },
    ]
    const result = translateDshNotification(
      frame("tool/result", {
        message: {
          source: { callId: "c" },
          content: [{ type: "tool-result", toolCallId: "c", content, isError: true }],
        },
        meta: { diff: "x" },
        error: { code: "X" },
      })
    )
    expect(result.events[0]).toMatchObject({
      type: "tool_result",
      toolUseId: "c",
      result: { content },
      isError: true,
      rawOutput: { content, meta: { diff: "x" }, error: { code: "X" } },
    })
  })
  it("joins every text-only tool result block", () => {
    expect(
      translateDshNotification(
        frame("tool/result", {
          message: {
            source: { callId: "c" },
            content: [
              {
                type: "tool-result",
                toolCallId: "c",
                content: [
                  { type: "text", text: "a" },
                  { type: "text", text: "b" },
                ],
              },
            ],
          },
        })
      ).events[0]
    ).toMatchObject({ result: "ab" })
  })
  it("uses parentSessionId for subagent lineage without exposing child reasoning as progress", () => {
    const result = translateDshNotification({
      method: "subagent.finished",
      params: {
        parentSessionId: "p",
        childSessionId: "c",
        provider: "local",
        agentId: "c",
        status: "ok",
        stopReason: "completed",
        lastAssistantMessage: [{ type: "reasoning", text: "private" }],
      },
    })
    expect(result.events[0]).toMatchObject({ type: "progress", sessionId: "p", progress: 1 })
    expect(JSON.stringify(result)).not.toContain("private")
  })
  it("retains unsuccessful attempt output outside the final answer and keeps thinking governed", () => {
    const result = translateDshNotification(
      frame("assistant/attempt", {
        stream: [
          { type: "text-chunks", texts: ["partial"] },
          { type: "reasoning-chunks", texts: ["secret"] },
          { type: "tool-call-chunks", name: "read", id: "c", args: [] },
          { type: "chunk", chunk: { type: "usage", usage: { inputTokens: 2, outputTokens: 1 } } },
          {
            type: "chunk",
            chunk: { type: "finish", reason: { kind: "error", failure: { message: "retrying" } } },
          },
        ],
      })
    )
    expect(result.events.some((event) => event.type === "message_delta")).toBe(false)
    expect(result.events.find((event) => event.type === "thinking")).toMatchObject({
      thinking: "secret",
    })
    expect(
      JSON.stringify(result.events.filter((event) => event.type === "progress"))
    ).not.toContain("secret")
  })
  it("recognizes current core and plugin event vocabulary", () => {
    for (const type of [
      "system/message",
      "user/message",
      "session/end-seed",
      "step/start",
      "step/end",
      "approval/policy",
      "agent/inbox/spliced",
      "compaction/prune",
      "todo/write",
      "tool/ptc-dispatch-start",
      "goal/change",
    ]) {
      expect(() => translateDshNotification(frame(type, {}))).not.toThrow()
    }
    expect(
      translateDshNotification(frame("session/title", { title: "Title" })).events[0]
    ).toMatchObject({ type: "session_info_update", title: "Title" })
  })
  it("preserves unsupported committed content as diagnostic progress", () => {
    expect(
      translateDshNotification(assistant([{ type: "file", attachment: { id: "f" } }])).events[1]
    ).toMatchObject({ type: "progress", message: expect.stringContaining('"id":"f"') })
  })
  it.each([
    frame("assistant/chunk", { chunk: { type: "text-delta", text: "legacy" } }),
    frame("future/event", {}),
    frame("future/event", { ignorable: true }),
    frame("turn/end", { reason: { kind: "future" } }),
  ])("refuses removed wire or unknown required semantics", (notification) => {
    expect(() => translateDshNotification(notification)).toThrow(DshVersionDriftError)
  })
  it("honors only the envelope ignorable marker", () => {
    expect(translateDshNotification(frame("plugin/unknown", {}, { ignorable: true }))).toEqual({
      events: [],
      warnings: [{ kind: "ignorable-unknown-event", detail: "plugin/unknown" }],
    })
  })
  it.each([
    null,
    { method: "session.event", params: {} },
    frame("assistant/message", {}),
    frame("tool/call", {}),
    frame("tool/result", {}),
    { method: "session.status", params: { sessionId: "s", status: "invalid" } },
    { method: "subagent.started", params: { parentSessionId: "s" } },
    frame("assistant/attempt", {}),
    frame("session/title", {}),
  ])("rejects malformed required payloads", (notification) => {
    expect(() => translateDshNotification(notification)).toThrow()
  })
  it("does not expose request provenance or system input as output", () => {
    for (const type of [
      "request/header",
      "request/context",
      "system/message",
      "user/message",
      "agent/inbox/spliced",
    ]) {
      expect(translateDshNotification(frame(type, { private: "reasoning replay" })).events).toEqual(
        []
      )
    }
  })
  it("reports an error without provider details as a failure", () => {
    expect(
      translateDshNotification(frame("turn/end", { reason: { kind: "error" } })).events[0]
    ).toMatchObject({ error: "DeepSeek Harness turn failed" })
  })
  it("handles absent accounting fields without producing NaN", () => {
    expect(
      translateDshNotification(
        assistant([], { inputTokens: NaN, outputTokens: Infinity, reasoningTokens: "invalid" })
      ).events.at(-1)
    ).toMatchObject({
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0 },
    })
  })
  it("handles attempt framing and missing failure details without exposing block reasoning", () => {
    const result = translateDshNotification(
      frame("assistant/attempt", {
        stream: [
          { type: "tool-call-chunks", id: "c" },
          { type: "tool-call-chunks" },
          { type: "chunk", chunk: { type: "block-start", blockType: "reasoning" } },
          {
            type: "chunk",
            chunk: { type: "block-end", block: { type: "reasoning", text: "private" } },
          },
          { type: "chunk", chunk: { type: "block-end", block: { type: "text", text: "partial" } } },
          { type: "chunk", chunk: { type: "finish" } },
        ],
      })
    )
    expect(JSON.stringify(result)).not.toContain("private")
    expect(result.events.at(-1)).toMatchObject({
      type: "progress",
      message: "assistant/attempt:unknown:",
    })
  })
  it.each([
    { params: { sessionId: "s" } },
    { method: "future/method", params: { sessionId: "s" } },
    { method: "session.event", params: { sessionId: "s" } },
    { method: "session.event", params: { sessionId: "s", event: { data: {} } } },
    frame("turn/end", {}),
    assistant([null]),
    assistant([{ type: "reasoning", text: 42 }]),
    frame("assistant/attempt", { stream: [null] }),
    frame("assistant/attempt", { stream: [{ type: "unknown" }] }),
    frame("assistant/attempt", { stream: [{}] }),
  ])("fails closed on malformed current frames and unknown compact records", (notification) => {
    expect(() => translateDshNotification(notification)).toThrow()
  })
  it("keeps batch wire order and session-scoped dedupe identities", () => {
    expect(
      translateDshNotifications([
        frame("turn/start", {}),
        frame("turn/end", { reason: { kind: "completed" } }),
      ]).events.map((event) => event.type)
    ).toEqual(["session_start", "done"])
    expect(dshEventDedupeKey("channel", "s", 1)).not.toBe(dshEventDedupeKey("channel", "other", 1))
    expect(dshEventDedupeKey("channel", "s", 1)).not.toBe(dshEventDedupeKey("other", "s", 1))
  })
})
