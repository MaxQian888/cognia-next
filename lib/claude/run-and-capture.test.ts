/**
 * Co-located unit test for `runAndCaptureAssistantReply`. Mocks the Tauri
 * IPC layer so we can drive synthetic event sequences and assert the
 * wrapper resolves / rejects correctly. The wrapper itself is pure — no
 * timers other than its watchdog, which we keep on (with a low
 * `timeoutMs` per case) to also exercise the timeout path.
 */

import {
  runAndCaptureAssistantReply,
  RunAndCaptureError,
  compactBoundaryFromInner,
  type CaptureStreamEvent,
} from "./run-and-capture"
import type { ClaudeEvent } from "./types"
import {
  registerChatMiddleware,
  __resetChatMiddlewareRegistryForTesting,
} from "./chat-middleware/registry"
import {
  setChatMiddlewareExecutionEnabled,
  __resetChatMiddlewareFlagForTesting,
} from "./chat-middleware/feature-flag"

// ── Mock the IPC layer the wrapper depends on ─────────────────────────────
// `onClaudeMessage` returns the unlistener; we capture the handler so the
// test can dispatch synthetic events.

let captured: ((evt: ClaudeEvent) => void) | null = null
const sendPromptMock = jest.fn<Promise<void>, [string, unknown, unknown?]>(async () => undefined)
const interruptSessionMock = jest.fn<Promise<void>, [string]>(async () => undefined)
const approveToolMock = jest.fn<Promise<void>, [string, string, string, string?, unknown?]>(
  async () => undefined
)
const toolResultDecisionMock = jest.fn<Promise<void>, [string, string, unknown?]>(
  async () => undefined
)
const unlistenMock = jest.fn()
const onClaudeMessageMock = jest.fn(async (handler: (evt: ClaudeEvent) => void) => {
  captured = handler
  return unlistenMock
})

jest.mock("./ipc", () => ({
  sendPrompt: (sessionId: string, prompt: unknown, options?: unknown) =>
    sendPromptMock(sessionId, prompt, options),
  interruptSession: (sessionId: string) => interruptSessionMock(sessionId),
  onClaudeMessage: (handler: (evt: ClaudeEvent) => void) => onClaudeMessageMock(handler),
  approveTool: (s: string, r: string, d: string, m?: string, u?: unknown) =>
    approveToolMock(s, r, d, m, u),
  toolResultDecision: (s: string, r: string, u?: unknown) => toolResultDecisionMock(s, r, u),
}))

beforeEach(() => {
  captured = null
  sendPromptMock.mockClear()
  interruptSessionMock.mockClear()
  approveToolMock.mockClear()
  toolResultDecisionMock.mockClear()
  unlistenMock.mockClear()
  onClaudeMessageMock.mockClear()
  __resetChatMiddlewareRegistryForTesting()
  __resetChatMiddlewareFlagForTesting()
})

// Spin the microtask queue until the IPC subscription lands (the middleware
// chain adds an extra async hop before `captureAssistantReplyCore` subscribes).
async function flushUntilSubscribed(): Promise<void> {
  for (let i = 0; i < 100 && !captured; i++) {
    await Promise.resolve()
  }
}

// Helper: dispatch a synthetic event to the captured handler.
const fire = (evt: ClaudeEvent) => {
  if (!captured) throw new Error("no handler captured — onClaudeMessage not called yet")
  captured(evt)
}

const SESSION = "ses_test"

const assistantEvent = (text: string, opts?: { uuid?: string }): ClaudeEvent =>
  ({
    type: "event",
    sessionId: SESSION,
    event: {
      type: "assistant",
      uuid: opts?.uuid ?? "uuid-asst-1",
      session_id: SESSION,
      message: {
        id: "m-1",
        role: "assistant",
        content: [{ type: "text", text }],
      },
    },
  }) as unknown as ClaudeEvent

const sessionEnded = (opts?: { error?: string; resultText?: string }): ClaudeEvent => ({
  type: "session_ended",
  sessionId: SESSION,
  error: opts?.error,
  result: opts?.resultText
    ? {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        is_error: false,
        result: opts.resultText,
        uuid: "uuid-result-1",
        session_id: SESSION,
      }
    : undefined,
})

describe("runAndCaptureAssistantReply", () => {
  it("resolves with assembled text from the assistant event", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    // Wait a microtask for the subscribe to land
    await Promise.resolve()
    fire(assistantEvent("Hello, world!"))
    fire(sessionEnded())
    const result = await promise
    expect(result.text).toBe("Hello, world!")
    expect(result.messageId).toBe("uuid-asst-1")
    expect(sendPromptMock).toHaveBeenCalledTimes(1)
    expect(sendPromptMock).toHaveBeenCalledWith(SESSION, "hi", undefined)
    expect(unlistenMock).toHaveBeenCalledTimes(1)
  })

  it("emits a usage stream event from an in-stream result message", async () => {
    const events: Array<{ type: string }> = []
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      timeoutMs: 1_000,
      onEvent: (e) => events.push(e),
    })
    await flushUntilSubscribed()
    fire(assistantEvent("Hi"))
    // The native sidecar streams a `result` message (and a result-less
    // session_ended), so usage must come from this in-stream event.
    fire({
      type: "event",
      sessionId: SESSION,
      event: {
        type: "result",
        subtype: "success",
        duration_ms: 1200,
        is_error: false,
        uuid: "uuid-result-1",
        session_id: SESSION,
        total_cost_usd: 0.42,
        usage: { input_tokens: 1000, output_tokens: 250 },
      },
    } as unknown as ClaudeEvent)
    fire(sessionEnded())
    await promise
    const usageEvent = events.find((e) => e.type === "usage") as
      | { type: "usage"; usage: { totalCostUsd?: number; inputTokens?: number } }
      | undefined
    expect(usageEvent).toBeDefined()
    expect(usageEvent?.usage.totalCostUsd).toBe(0.42)
    expect(usageEvent?.usage.inputTokens).toBe(1000)
  })

  it("falls back to result.result when assistant text is empty", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await Promise.resolve()
    fire(sessionEnded({ resultText: "fallback text" }))
    const result = await promise
    expect(result.text).toBe("fallback text")
    expect(result.messageId).toBe("uuid-result-1")
  })

  it("ignores events from other sessions", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await Promise.resolve()
    // Other-session events must NOT contribute text
    fire({
      type: "event",
      sessionId: "other-session",
      event: {
        type: "assistant",
        uuid: "wrong-uuid",
        session_id: "other-session",
        message: { id: "m-x", role: "assistant", content: [{ type: "text", text: "WRONG" }] },
      },
    } as unknown as ClaudeEvent)
    fire(assistantEvent("right text"))
    fire(sessionEnded())
    const result = await promise
    expect(result.text).toBe("right text")
  })

  it("rejects when session_ended carries an error", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await Promise.resolve()
    fire(sessionEnded({ error: "rate-limited" }))
    await expect(promise).rejects.toMatchObject({
      name: "RunAndCaptureError",
      code: "session_error",
      message: "rate-limited",
    })
    expect(unlistenMock).toHaveBeenCalledTimes(1)
  })

  it("rejects with no_assistant_text when nothing was captured", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await Promise.resolve()
    fire(sessionEnded())
    await expect(promise).rejects.toMatchObject({
      code: "no_assistant_text",
    })
  })

  it("rejects when sidecar exits mid-run", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await Promise.resolve()
    fire({ type: "sidecar_exited" })
    await expect(promise).rejects.toMatchObject({
      code: "session_error",
    })
  })

  it("aborts cleanly on signal abort and fires interruptSession", async () => {
    const ac = new AbortController()
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      signal: ac.signal,
      timeoutMs: 1_000,
    })
    await Promise.resolve()
    ac.abort()
    await expect(promise).rejects.toMatchObject({ code: "aborted" })
    expect(interruptSessionMock).toHaveBeenCalledWith(SESSION)
    expect(unlistenMock).toHaveBeenCalledTimes(1)
  })

  it("rejects synchronously when signal is already aborted", async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(
      runAndCaptureAssistantReply(SESSION, "hi", undefined, { signal: ac.signal })
    ).rejects.toMatchObject({ code: "aborted" })
    expect(onClaudeMessageMock).not.toHaveBeenCalled()
  })

  it("rejects with send_failed when sendPrompt rejects", async () => {
    sendPromptMock.mockRejectedValueOnce(new Error("boom"))
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await expect(promise).rejects.toMatchObject({
      code: "send_failed",
      message: expect.stringContaining("boom"),
    })
  })

  it("rejects with session_error when no event arrives within timeoutMs", async () => {
    jest.useFakeTimers()
    try {
      const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 50 })
      // Allow the subscribe + sendPrompt promise chain to settle so the
      // watchdog timer is registered.
      await Promise.resolve()
      await Promise.resolve()
      jest.advanceTimersByTime(60)
      await expect(promise).rejects.toMatchObject({ code: "session_error" })
    } finally {
      jest.useRealTimers()
    }
  })

  it("does not leak its event subscription across runs", async () => {
    const p1 = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await Promise.resolve()
    fire(assistantEvent("first"))
    fire(sessionEnded())
    await p1

    const p2 = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await Promise.resolve()
    fire(assistantEvent("second"))
    fire(sessionEnded())
    const result = await p2
    expect(result.text).toBe("second")
    expect(unlistenMock).toHaveBeenCalledTimes(2)
  })

  it("exposes RunAndCaptureError as an Error subclass with code", () => {
    const err = new RunAndCaptureError("nope", "send_failed")
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe("send_failed")
    expect(err.name).toBe("RunAndCaptureError")
  })

  // ── Chat-middleware execution (ADR-0026 §4 §A, default-off flag) ───────

  it("does not run registered middlewares when the execution flag is off (default)", async () => {
    registerChatMiddleware({
      pluginId: "p",
      middlewareId: "upper",
      fn: async (_req, next) => {
        const r = await next()
        return { ...r, text: r.text.toUpperCase() }
      },
    })
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await Promise.resolve()
    fire(assistantEvent("hello"))
    fire(sessionEnded())
    const result = await promise
    expect(result.text).toBe("hello") // middleware skipped — flag off
  })

  it("runs a registered middleware when execution is enabled, transforming the reply text", async () => {
    setChatMiddlewareExecutionEnabled(true)
    registerChatMiddleware({
      pluginId: "p",
      middlewareId: "upper",
      fn: async (_req, next) => {
        const r = await next()
        return { ...r, text: r.text.toUpperCase() }
      },
    })
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await flushUntilSubscribed()
    fire(assistantEvent("hello"))
    fire(sessionEnded())
    const result = await promise
    expect(result.text).toBe("HELLO")
    // The full RunAndCaptureResult is preserved — only text is transformed.
    expect(result.messageId).toBe("uuid-asst-1")
  })

  it("returns the middleware text (empty surfaces) when a middleware short-circuits next()", async () => {
    setChatMiddlewareExecutionEnabled(true)
    registerChatMiddleware({
      pluginId: "p",
      middlewareId: "block",
      fn: async () => ({ text: "blocked" }),
    })
    // The middleware never calls next() → the real turn never runs, so no IPC
    // events are needed and the promise resolves from the middleware alone.
    const result = await runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    expect(result.text).toBe("blocked")
    expect(result.messageId).toBe("")
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  // ── A2UI surface accumulator (G2 addition) ────────────────────────────

  const a2uiToolCall = (
    name: string,
    input: Record<string, unknown>,
    opts?: { uuid?: string; text?: string }
  ): ClaudeEvent =>
    ({
      type: "event",
      sessionId: SESSION,
      event: {
        type: "assistant",
        uuid: opts?.uuid ?? "uuid-asst-tool",
        session_id: SESSION,
        message: {
          id: "m-tool",
          role: "assistant",
          content: [
            ...(opts?.text ? [{ type: "text", text: opts.text }] : []),
            { type: "tool_use", id: "tu_1", name, input },
          ],
        },
      },
    }) as unknown as ClaudeEvent

  it("captures A2UI surfaces from a2ui_create_surface tool_use blocks", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await Promise.resolve()
    fire(
      a2uiToolCall(
        "mcp__a2ui-bridge__a2ui_create_surface",
        { surfaceId: "sfc1", surfaceType: "inline", title: "Hello" },
        { text: "here is a card" }
      )
    )
    fire(sessionEnded())
    const result = await promise
    expect(result.text).toBe("here is a card")
    expect(result.a2uiSurfaceOrder).toEqual(["sfc1"])
    expect(result.a2uiSurfaces["sfc1"]).toMatchObject({
      surfaceType: "inline",
      title: "Hello",
      rootId: "root",
    })
  })

  it("merges a2ui_update_components into the surface map", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await Promise.resolve()
    fire(
      a2uiToolCall("mcp__a2ui-bridge__a2ui_create_surface", {
        surfaceId: "sfc1",
        surfaceType: "inline",
      })
    )
    fire(
      a2uiToolCall(
        "mcp__a2ui-bridge__a2ui_update_components",
        {
          surfaceId: "sfc1",
          components: [
            { id: "root", component: "Card", title: "T", children: ["t1"] },
            { id: "t1", component: "Text", text: "hi" },
          ],
        },
        { text: "done", uuid: "uuid-asst-2" }
      )
    )
    fire(sessionEnded())
    const result = await promise
    expect(result.a2uiSurfaces["sfc1"].components.root).toMatchObject({
      component: "Card",
      title: "T",
    })
    expect(result.a2uiSurfaces["sfc1"].components.t1).toMatchObject({
      component: "Text",
      text: "hi",
    })
  })

  it("supports surface-only turns (no text + at least one surface)", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await Promise.resolve()
    fire(
      a2uiToolCall("mcp__a2ui-bridge__a2ui_create_surface", {
        surfaceId: "sfc_only",
        surfaceType: "panel",
      })
    )
    fire(sessionEnded())
    const result = await promise
    // No text was emitted — should NOT throw no_assistant_text.
    expect(result.text).toBe("")
    expect(result.a2uiSurfaceOrder).toEqual(["sfc_only"])
  })

  it("data_model_update merges (default) or replaces dataModel based on `merge`", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await Promise.resolve()
    fire(
      a2uiToolCall("mcp__a2ui-bridge__a2ui_create_surface", {
        surfaceId: "sfc",
        surfaceType: "inline",
      })
    )
    fire(
      a2uiToolCall("mcp__a2ui-bridge__a2ui_data_model_update", {
        surfaceId: "sfc",
        data: { name: "Alice", age: 30 },
      })
    )
    fire(
      a2uiToolCall(
        "mcp__a2ui-bridge__a2ui_data_model_update",
        { surfaceId: "sfc", data: { age: 31 } },
        { text: "ok" }
      )
    )
    fire(sessionEnded())
    const result = await promise
    expect(result.a2uiSurfaces["sfc"].dataModel).toEqual({ name: "Alice", age: 31 })
  })

  it("a2ui_delete_surface removes from accumulator and order", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await Promise.resolve()
    fire(
      a2uiToolCall("mcp__a2ui-bridge__a2ui_create_surface", {
        surfaceId: "sfc",
        surfaceType: "inline",
      })
    )
    fire(
      a2uiToolCall("mcp__a2ui-bridge__a2ui_delete_surface", { surfaceId: "sfc" }, { text: "done" })
    )
    fire(sessionEnded())
    const result = await promise
    expect(result.a2uiSurfaceOrder).toEqual([])
    expect(result.a2uiSurfaces).toEqual({})
  })

  it("ignores tool_use blocks that aren't a2ui-bridge tools", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await Promise.resolve()
    fire(a2uiToolCall("mcp__some-other-server__some_tool", { stuff: 1 }, { text: "hi" }))
    fire(sessionEnded())
    const result = await promise
    expect(result.a2uiSurfaceOrder).toEqual([])
    expect(result.text).toBe("hi")
  })

  // ── onPartial incremental-output callback (streaming connectors) ──────

  it("fires onPartial with the growing accumulated text", async () => {
    const partials: string[] = []
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      timeoutMs: 1_000,
      onPartial: (t) => {
        partials.push(t)
      },
    })
    await Promise.resolve()
    // Three streamed assistant events with the SAME uuid carrying the
    // full text-so-far (mirrors how the SDK streams partial messages).
    fire(assistantEvent("Hel", { uuid: "u1" }))
    fire(assistantEvent("Hello", { uuid: "u1" }))
    fire(assistantEvent("Hello, world!", { uuid: "u1" }))
    fire(sessionEnded())
    const result = await promise
    expect(result.text).toBe("Hello, world!")
    expect(partials).toEqual(["Hel", "Hello", "Hello, world!"])
  })

  it("does not re-fire onPartial when the accumulated text is unchanged", async () => {
    const partials: string[] = []
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      timeoutMs: 1_000,
      onPartial: (t) => {
        partials.push(t)
      },
    })
    await Promise.resolve()
    fire(assistantEvent("same", { uuid: "u1" }))
    fire(assistantEvent("same", { uuid: "u1" }))
    fire(sessionEnded())
    await promise
    expect(partials).toEqual(["same"])
  })

  it("swallows a throwing onPartial without breaking capture", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      timeoutMs: 1_000,
      onPartial: () => {
        throw new Error("callback boom")
      },
    })
    await Promise.resolve()
    fire(assistantEvent("Hello"))
    fire(sessionEnded())
    const result = await promise
    expect(result.text).toBe("Hello")
  })

  it("swallows a rejecting async onPartial without breaking capture", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      timeoutMs: 1_000,
      onPartial: async () => {
        throw new Error("async boom")
      },
    })
    await Promise.resolve()
    fire(assistantEvent("Hello"))
    fire(sessionEnded())
    const result = await promise
    expect(result.text).toBe("Hello")
  })

  // ── onEvent typed stream + onPermissionRequest responder (Agent SDK seam) ──

  const toolUseEvent = (name: string, input: Record<string, unknown>): ClaudeEvent =>
    ({
      type: "event",
      sessionId: SESSION,
      event: {
        type: "assistant",
        uuid: "uuid-tool-1",
        session_id: SESSION,
        message: {
          id: "m-t",
          role: "assistant",
          content: [{ type: "tool_use", name, input }],
        },
      },
    }) as unknown as ClaudeEvent

  const permissionRequest = (
    requestId: string,
    toolName: string,
    input: Record<string, unknown>
  ): ClaudeEvent =>
    ({
      type: "permission_request",
      sessionId: SESSION,
      requestId,
      toolUseID: "tu-1",
      toolName,
      input,
    }) as unknown as ClaudeEvent

  it("emits text-delta events for the newly-grown suffix only", async () => {
    const events: Array<{ type: string; delta?: string }> = []
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      timeoutMs: 1_000,
      onEvent: (e) => events.push(e),
    })
    await Promise.resolve()
    fire(assistantEvent("Hel"))
    fire(assistantEvent("Hello"))
    fire(sessionEnded())
    await promise
    const deltas = events.filter((e) => e.type === "text-delta").map((e) => e.delta)
    expect(deltas).toEqual(["Hel", "lo"])
  })

  const thinkingEvent = (thinking: string, text?: string): ClaudeEvent =>
    ({
      type: "event",
      sessionId: SESSION,
      event: {
        type: "assistant",
        uuid: "uuid-think-1",
        session_id: SESSION,
        message: {
          id: "m-think",
          role: "assistant",
          content: [{ type: "thinking", thinking }, ...(text ? [{ type: "text", text }] : [])],
        },
      },
    }) as unknown as ClaudeEvent

  it("emits thinking-delta for the newly-grown suffix and never leaks into text", async () => {
    const events: Array<{ type: string; delta?: string }> = []
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      timeoutMs: 1_000,
      onEvent: (e) => events.push(e),
    })
    await Promise.resolve()
    fire(thinkingEvent("Let me"))
    fire(thinkingEvent("Let me think", "Answer"))
    fire(sessionEnded())
    const result = await promise
    const thinkingDeltas = events.filter((e) => e.type === "thinking-delta").map((e) => e.delta)
    expect(thinkingDeltas).toEqual(["Let me", " think"])
    // Reasoning must never appear in the final assembled text.
    expect(result.text).toBe("Answer")
    expect(result.text).not.toContain("think")
  })

  const compactBoundary = (trigger: "manual" | "auto", pre: number, post: number): ClaudeEvent =>
    ({
      type: "event",
      sessionId: SESSION,
      event: {
        type: "system",
        subtype: "compact_boundary",
        uuid: "uuid-compact-1",
        session_id: SESSION,
        compact_metadata: { trigger, pre_tokens: pre, post_tokens: post },
      },
    }) as unknown as ClaudeEvent

  it("emits a typed compact event when a compaction boundary streams in", async () => {
    const events: CaptureStreamEvent[] = []
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      timeoutMs: 1_000,
      onEvent: (e) => events.push(e),
    })
    await flushUntilSubscribed()
    fire(compactBoundary("auto", 45_000, 8_000))
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await promise
    expect(events.find((e) => e.type === "compact")).toEqual({
      type: "compact",
      trigger: "auto",
      preTokens: 45_000,
      postTokens: 8_000,
    })
  })

  it("emits a tool-call event for tool_use blocks", async () => {
    const events: Array<{ type: string; toolName?: string }> = []
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      timeoutMs: 1_000,
      onEvent: (e) => events.push(e),
    })
    await Promise.resolve()
    fire(toolUseEvent("web_fetch", { url: "x" }))
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await promise
    expect(events.find((e) => e.type === "tool-call")).toMatchObject({
      type: "tool-call",
      toolName: "web_fetch",
    })
  })

  it("emits a tool-call only ONCE per tool_use id even when later snapshots repeat the block", async () => {
    // The AI SDK event-adapter re-includes a completed tool_use block in every
    // subsequent streaming snapshot. Without id-dedup that surfaced one
    // tool-call event per delta — flooding consumers and (in the CLI) stacking a
    // running tool cell + committing an assistant cell on each one.
    const events: Array<{ type: string; toolName?: string }> = []
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      timeoutMs: 1_000,
      onEvent: (e) => events.push(e),
    })
    await Promise.resolve()
    fire(toolUseEventWithId("tu_1", "ls", { path: "." }))
    fire(toolUseEventWithId("tu_1", "ls", { path: "." }))
    fire(toolUseEventWithId("tu_1", "ls", { path: "." }))
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await promise
    const toolCalls = events.filter((e) => e.type === "tool-call")
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]).toMatchObject({ type: "tool-call", toolName: "ls" })
  })

  it("does not reject a tool-only turn (tool calls, no closing text)", async () => {
    // Multi-round tool sessions that end after a tool call without a final
    // text summary used to crash with no_assistant_text. The tool calls ARE the
    // turn's content, so this resolves with empty text instead.
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await Promise.resolve()
    fire(toolUseEventWithId("tu_only", "ls", { path: "." }))
    fire(sessionEnded())
    const result = await promise
    expect(result.text).toBe("")
  })

  const toolUseEventWithId = (
    id: string,
    name: string,
    input: Record<string, unknown>
  ): ClaudeEvent =>
    ({
      type: "event",
      sessionId: SESSION,
      event: {
        type: "assistant",
        uuid: "uuid-tu",
        session_id: SESSION,
        message: {
          id: "m-tu",
          role: "assistant",
          content: [{ type: "tool_use", id, name, input }],
        },
      },
    }) as unknown as ClaudeEvent

  const userToolResultEvent = (toolUseId: string, content: unknown, isError = false): ClaudeEvent =>
    ({
      type: "event",
      sessionId: SESSION,
      event: {
        type: "user",
        uuid: "uuid-ur",
        session_id: SESSION,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
        },
      },
    }) as unknown as ClaudeEvent

  it("emits a tool-result event correlated to its tool_use (name + input)", async () => {
    const events: Array<{
      type: string
      toolName?: string
      input?: unknown
      result?: unknown
      isError?: boolean
    }> = []
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      timeoutMs: 1_000,
      onEvent: (e) => events.push(e),
    })
    await Promise.resolve()
    fire(toolUseEventWithId("tu_9", "web_fetch", { url: "x" }))
    fire(userToolResultEvent("tu_9", "RAW OUTPUT", false))
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await promise
    expect(events.find((e) => e.type === "tool-result")).toMatchObject({
      type: "tool-result",
      toolName: "web_fetch",
      input: { url: "x" },
      result: "RAW OUTPUT",
      isError: false,
    })
  })

  it("emits a tool-result with empty toolName when no matching tool_use", async () => {
    const events: Array<{ type: string; toolName?: string; isError?: boolean }> = []
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      timeoutMs: 1_000,
      onEvent: (e) => events.push(e),
    })
    await Promise.resolve()
    fire(userToolResultEvent("nope", "ERR", true))
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await promise
    expect(events.find((e) => e.type === "tool-result")).toMatchObject({
      type: "tool-result",
      toolName: "",
      isError: true,
    })
  })

  const toolResultReview = (
    reviewId: string,
    toolUseId: string,
    toolName: string,
    result: unknown,
    isError = false
  ): ClaudeEvent =>
    ({
      type: "tool_result_review",
      sessionId: SESSION,
      reviewId,
      toolUseId,
      toolName,
      result,
      isError,
    }) as unknown as ClaudeEvent

  it("answers a tool_result_review via toolResultDecision with a rewritten output", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      timeoutMs: 1_000,
      onToolResultReview: (req) => ({ updatedToolOutput: `redacted:${req.toolName}` }),
    })
    await Promise.resolve()
    // The prior tool_use lets the responder see the correlated input.
    fire(toolUseEventWithId("tu_r", "web_fetch", { url: "secret" }))
    fire(toolResultReview("rev_1", "tu_r", "web_fetch", "RAW", false))
    await Promise.resolve()
    await Promise.resolve()
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await promise
    expect(toolResultDecisionMock).toHaveBeenCalledWith(SESSION, "rev_1", "redacted:web_fetch")
  })

  it("correlates input from the originating tool_use into the review responder", async () => {
    const seen: unknown[] = []
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      timeoutMs: 1_000,
      onToolResultReview: (req) => {
        seen.push(req)
        return {}
      },
    })
    await Promise.resolve()
    fire(toolUseEventWithId("tu_x", "web_fetch", { url: "u" }))
    fire(toolResultReview("rev_2", "tu_x", "web_fetch", "RAW", false))
    await Promise.resolve()
    await Promise.resolve()
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await promise
    expect(seen[0]).toEqual({
      toolName: "web_fetch",
      input: { url: "u" },
      result: "RAW",
      isError: false,
    })
  })

  it("fail-open: a throwing review responder sends an unchanged decision", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      timeoutMs: 1_000,
      onToolResultReview: () => {
        throw new Error("responder boom")
      },
    })
    await Promise.resolve()
    fire(toolResultReview("rev_3", "tu_z", "web_fetch", "RAW", false))
    await Promise.resolve()
    await Promise.resolve()
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await promise
    expect(toolResultDecisionMock).toHaveBeenCalledWith(SESSION, "rev_3", undefined)
  })

  it("does not re-fire the responder at observation for an already-reviewed tool", async () => {
    const calls: string[] = []
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      timeoutMs: 1_000,
      onToolResultReview: (req) => {
        calls.push(req.toolName)
        return {}
      },
    })
    await Promise.resolve()
    fire(toolUseEventWithId("tu_d", "web_fetch", { url: "u" }))
    // Review first (marks tu_d reviewed), then the observation tool_result.
    fire(toolResultReview("rev_4", "tu_d", "web_fetch", "RAW", false))
    await Promise.resolve()
    fire(userToolResultEvent("tu_d", "RAW", false))
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await promise
    expect(calls).toEqual(["web_fetch"]) // exactly once (review), not twice
  })

  it("fires the responder at observation for an unreviewed tool result", async () => {
    const calls: string[] = []
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      timeoutMs: 1_000,
      onToolResultReview: (req) => {
        calls.push(req.toolName)
        return {}
      },
    })
    await Promise.resolve()
    fire(toolUseEventWithId("tu_o", "web_fetch", { url: "u" }))
    fire(userToolResultEvent("tu_o", "RAW", false))
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await promise
    expect(calls).toEqual(["web_fetch"]) // observation fired once
  })

  it("swallows a throwing onEvent callback", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      timeoutMs: 1_000,
      onEvent: () => {
        throw new Error("boom")
      },
    })
    await Promise.resolve()
    fire(assistantEvent("Hello"))
    fire(sessionEnded())
    const result = await promise
    expect(result.text).toBe("Hello")
  })

  it("answers a permission_request via approveTool with a rewritten input", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      timeoutMs: 1_000,
      onPermissionRequest: (req) => ({
        decision: "allow",
        updatedInput: { ...req.input, url: "<REDACTED>" },
      }),
    })
    await Promise.resolve()
    fire(permissionRequest("req-1", "web_fetch", { url: "secret" }))
    // Let the async responder run.
    await Promise.resolve()
    await Promise.resolve()
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await promise
    expect(approveToolMock).toHaveBeenCalledWith(SESSION, "req-1", "allow", undefined, {
      url: "<REDACTED>",
    })
  })

  it("swallows an approveTool rejection without breaking capture", async () => {
    approveToolMock.mockRejectedValueOnce(new Error("approve failed"))
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      timeoutMs: 1_000,
      onPermissionRequest: () => ({ decision: "allow" }),
    })
    await Promise.resolve()
    fire(permissionRequest("req-3", "web_fetch", { url: "x" }))
    await Promise.resolve()
    await Promise.resolve()
    fire(assistantEvent("done"))
    fire(sessionEnded())
    const result = await promise
    expect(result.text).toBe("done")
  })

  it("denies via approveTool when the permission responder throws", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      timeoutMs: 1_000,
      onPermissionRequest: () => {
        throw new Error("gate failed")
      },
    })
    await Promise.resolve()
    fire(permissionRequest("req-2", "bash", { cmd: "rm" }))
    await Promise.resolve()
    await Promise.resolve()
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await promise
    expect(approveToolMock).toHaveBeenCalledWith(
      SESSION,
      "req-2",
      "deny",
      "permission responder failed",
      undefined
    )
  })
})

describe("compactBoundaryFromInner", () => {
  it("maps a compact_boundary system message to the typed compact event", () => {
    expect(
      compactBoundaryFromInner({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 90_000, post_tokens: 12_000 },
      })
    ).toEqual({ type: "compact", trigger: "manual", preTokens: 90_000, postTokens: 12_000 })
  })

  it("defaults a non-manual / missing trigger to auto and coerces non-numeric tokens to 0", () => {
    expect(
      compactBoundaryFromInner({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { pre_tokens: "x" },
      })
    ).toEqual({ type: "compact", trigger: "auto", preTokens: 0, postTokens: 0 })
  })

  it("returns null for non-boundary inputs", () => {
    expect(compactBoundaryFromInner(null)).toBeNull()
    expect(compactBoundaryFromInner({ type: "assistant" })).toBeNull()
    expect(compactBoundaryFromInner({ type: "system", subtype: "init" })).toBeNull()
  })
})
