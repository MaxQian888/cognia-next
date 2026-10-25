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
  retryFromInner,
  type CaptureStreamEvent,
} from "./run-and-capture"
import { hasCaptureResponder } from "@/lib/connectors/hitl/approval-registry"
import {
  __resetCapturedTurnsForTesting,
  capturedTurnOf,
} from "@/lib/policy/action-review/captured-turns"
import { registerImElicitationContext } from "@/lib/connectors/hitl/im-elicitation-context"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import type { approveTool } from "./ipc"
import type { AppSettings, ClaudeEvent, PermissionRequestEvent } from "@cognia/agent-config-types"
import { __resetFusionScopesForTesting } from "@/lib/router-fusion/gate/explicit-run"
import {
  registerChatMiddleware,
  __resetChatMiddlewareRegistryForTesting,
} from "./chat-middleware/registry"
import {
  registerInterceptor,
  __resetInterceptorRegistryForTesting,
} from "@/lib/plugin/interceptors"
import {
  setChatMiddlewareExecutionEnabled,
  __resetChatMiddlewareFlagForTesting,
} from "./chat-middleware/feature-flag"
import { getExecutionBroker, __resetExecutionBrokerForTesting } from "@/lib/execution/broker"

// ── Mock the IPC layer the wrapper depends on ─────────────────────────────
// `onClaudeMessage` returns the unlistener; we capture the handler so the
// test can dispatch synthetic events.

let captured: ((evt: ClaudeEvent) => void) | null = null
const sendPromptMock = jest.fn<Promise<void>, [string, unknown, unknown?, unknown?]>(
  async () => undefined
)
const interruptSessionMock = jest.fn<Promise<void>, [string]>(async () => undefined)
const approveToolMock = jest.fn<Promise<void>, Parameters<typeof approveTool>>(
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

const preToolUseMock = jest.fn(async () => ({ action: "allow" }))
const postToolUseMock = jest.fn(async () => ({}))
jest.mock("@/lib/claude/adapter-hooks", () => ({
  dispatchPreToolUse: (...args: unknown[]) => (preToolUseMock as jest.Mock)(...args),
  dispatchPostToolUse: (...args: unknown[]) => (postToolUseMock as jest.Mock)(...args),
}))

const answerWithOutboundPolicyMock = jest.fn()
const recordOutboundShadowMock = jest.fn(async (..._args: unknown[]) => {})
jest.mock("@/lib/policy/action-review/plan-tool-call", () => ({
  answerWithOutboundPolicy: (...args: unknown[]) => answerWithOutboundPolicyMock(...args),
  recordOutboundShadowObservation: (...args: unknown[]) => recordOutboundShadowMock(...args),
}))

const subscribeAgentEventsMock = jest.fn()
jest.mock("./ipc", () => ({
  // A delivery hint is forwarded only when given, so the many three-argument
  // call assertions keep describing the default send.
  sendPrompt: (sessionId: string, prompt: unknown, options?: unknown, delivery?: unknown) =>
    delivery === undefined
      ? sendPromptMock(sessionId, prompt, options)
      : sendPromptMock(sessionId, prompt, options, delivery),
  interruptSession: (sessionId: string) => interruptSessionMock(sessionId),
  onClaudeMessage: (handler: (evt: ClaudeEvent) => void) => onClaudeMessageMock(handler),
  approveTool: (...args: Parameters<typeof approveTool>) => approveToolMock(...args),
  toolResultDecision: (s: string, r: string, u?: unknown) => toolResultDecisionMock(s, r, u),
  subscribeAgentEvents: (cb: (e: unknown) => void) => subscribeAgentEventsMock(cb),
}))

beforeEach(() => {
  // Interceptor registrations are module-global; leaking one turns every
  // later test in this file into a middleware test.
  __resetInterceptorRegistryForTesting()
  captured = null
  preToolUseMock.mockReset().mockResolvedValue({ action: "allow" })
  postToolUseMock.mockReset().mockResolvedValue({})
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

// Drain a handful of microtasks — used after subscription to let the
// `onClaudeMessage(...).then(...)` continuation dispatch `sendPrompt`.
async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
  }
}

// Helper: dispatch a synthetic event to the captured handler.
const fire = (evt: ClaudeEvent) => {
  if (!captured) throw new Error("no handler captured — onClaudeMessage not called yet")
  captured(evt)
}

const SESSION = "ses_test"

const assistantEvent = (text: string, opts?: { uuid?: string; messageId?: string }): ClaudeEvent =>
  ({
    type: "event",
    sessionId: SESSION,
    event: {
      type: "assistant",
      uuid: opts?.uuid ?? "uuid-asst-1",
      session_id: SESSION,
      message: {
        id: opts?.messageId ?? "m-1",
        role: "assistant",
        content: [{ type: "text", text }],
      },
    },
  }) as unknown as ClaudeEvent

const sessionEnded = (opts?: {
  error?: string
  resultText?: string
  httpStatus?: number
  retryAfterMs?: number
}): ClaudeEvent => ({
  type: "session_ended",
  sessionId: SESSION,
  error: opts?.error,
  ...(opts?.httpStatus !== undefined ? { httpStatus: opts.httpStatus } : {}),
  ...(opts?.retryAfterMs !== undefined ? { retryAfterMs: opts.retryAfterMs } : {}),
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
    // Wait for the subscribe to land (broker admission + the IPC `.then` add a
    // couple of microtask hops before `sendPrompt` is dispatched).
    await flushUntilSubscribed()
    await flushMicrotasks()
    fire(assistantEvent("Hello, world!"))
    fire(sessionEnded())
    const result = await promise
    expect(result.text).toBe("Hello, world!")
    expect(result.messageId).toBe("uuid-asst-1")
    expect(sendPromptMock).toHaveBeenCalledTimes(1)
    // Every send is stamped with a turn id — the sidecar echoes it back so a
    // capture can tell its own events from a previous turn's leftovers.
    expect(sendPromptMock).toHaveBeenCalledWith(SESSION, "hi", { turnId: expect.any(String) })
    expect(unlistenMock).toHaveBeenCalledTimes(1)
  })

  it("preserves a caller-frozen turn id instead of reminting at dispatch", async () => {
    const promise = runAndCaptureAssistantReply(
      SESSION,
      "hi",
      { turnId: "turn-frozen" },
      { timeoutMs: 1_000 }
    )
    await flushUntilSubscribed()
    await flushMicrotasks()
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await promise
    expect(sendPromptMock).toHaveBeenCalledWith(SESSION, "hi", { turnId: "turn-frozen" })
  })

  it("forwards a host-owned transcript so the send skips the app's transcript preparation", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      timeoutMs: 1_000,
      transcriptRuntime: "host-owned",
    })
    await flushUntilSubscribed()
    await flushMicrotasks()
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await promise
    expect(sendPromptMock).toHaveBeenCalledWith(
      SESSION,
      "hi",
      { turnId: expect.any(String) },
      { transcriptRuntime: "host-owned" }
    )
  })

  it("retains the provider conversation snapshot from the terminal frame", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "next", undefined, { timeoutMs: 1_000 })
    await flushUntilSubscribed()
    const conversationSnapshot = [{ role: "user", content: "original" }]
    fire(assistantEvent("continued"))
    fire({ ...sessionEnded(), conversationSnapshot } as ClaudeEvent)
    await expect(promise).resolves.toEqual(expect.objectContaining({ conversationSnapshot }))
  })

  it("surfaces the SDK session id immediately as well as on the final result", async () => {
    const onSdkSessionId = jest.fn()
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      timeoutMs: 1_000,
      onSdkSessionId,
    })
    await flushUntilSubscribed()
    fire({
      type: "sdk_session_id",
      sessionId: SESSION,
      sdkSessionId: "sdk-issued",
    } as unknown as ClaudeEvent)
    expect(onSdkSessionId).toHaveBeenCalledWith("sdk-issued")
    fire(assistantEvent("Hello"))
    fire(sessionEnded())

    await expect(promise).resolves.toEqual(expect.objectContaining({ sdkSessionId: "sdk-issued" }))
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
      { type: "usage"; usage: { totalCostUsd?: number; inputTokens?: number } } | undefined
    expect(usageEvent).toBeDefined()
    expect(usageEvent?.usage.totalCostUsd).toBe(0.42)
    expect(usageEvent?.usage.inputTokens).toBe(1000)
  })

  it.each(["error_max_turns", "error_max_budget_usd"])(
    "retains an empty budget stop (%s) instead of replacing it with no_assistant_text",
    async (subtype) => {
      const promise = runAndCaptureAssistantReply(SESSION, "research", undefined, {
        timeoutMs: 1_000,
      })
      await flushUntilSubscribed()
      fire({
        type: "event",
        sessionId: SESSION,
        event: { type: "result", subtype, is_error: true },
      } as unknown as ClaudeEvent)
      fire(sessionEnded())
      await expect(promise).resolves.toMatchObject({ text: "", resultSubtype: subtype })
    }
  )

  it("returns structured output from an in-stream SDK result without requiring prose", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await flushUntilSubscribed()
    fire({
      type: "event",
      sessionId: SESSION,
      event: {
        type: "result",
        subtype: "success",
        is_error: false,
        structured_output: { summary: "shipped" },
        uuid: "uuid-result-1",
        session_id: SESSION,
      },
    } as unknown as ClaudeEvent)
    fire(sessionEnded())

    await expect(promise).resolves.toMatchObject({
      text: "",
      structuredOutput: { summary: "shipped" },
      resultSubtype: "success",
    })
  })

  it("prefers structured output carried by the terminal result envelope", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await flushUntilSubscribed()
    fire({
      type: "session_ended",
      sessionId: SESSION,
      result: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "",
        structured_output: { summary: "terminal" },
        uuid: "uuid-result-2",
        session_id: SESSION,
      },
    } as unknown as ClaudeEvent)

    await expect(promise).resolves.toMatchObject({
      text: "",
      structuredOutput: { summary: "terminal" },
    })
  })

  it("emits a partial usage event from an assistant message's own usage", async () => {
    const events: Array<{ type: string; partial?: boolean; usage?: { inputTokens?: number } }> = []
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      timeoutMs: 1_000,
      onEvent: (e) => events.push(e as never),
    })
    await flushUntilSubscribed()
    // An assistant message carrying per-call usage → a mid-run partial snapshot.
    fire({
      type: "event",
      sessionId: SESSION,
      event: {
        type: "assistant",
        uuid: "uuid-asst-1",
        session_id: SESSION,
        message: {
          id: "m-1",
          role: "assistant",
          content: [{ type: "text", text: "streaming…" }],
          usage: { input_tokens: 120, output_tokens: 30 },
        },
      },
    } as unknown as ClaudeEvent)
    fire(sessionEnded())
    await promise
    const partial = events.find((e) => e.type === "usage" && e.partial === true)
    expect(partial).toBeDefined()
    expect(partial?.usage?.inputTokens).toBe(120)
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

  it("carries the sidecar's HTTP metadata onto the rejection", async () => {
    // `code` is a CAPTURE label, not an errno, so a caller that classifies off
    // it alone reported every provider failure as a transport error. The status
    // the sidecar forwarded is what makes a 404 distinguishable from a socket
    // reset without string-matching the message.
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await Promise.resolve()
    fire(sessionEnded({ error: "HTTP 404: model not found", httpStatus: 404, retryAfterMs: 1_500 }))
    await expect(promise).rejects.toMatchObject({
      code: "session_error",
      httpStatus: 404,
      retryAfterMs: 1_500,
    })
  })

  it("omits HTTP metadata the sidecar did not send", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await Promise.resolve()
    fire(sessionEnded({ error: "boom" }))
    const error = await promise.then(
      () => null,
      (e: unknown) => e as { httpStatus?: number; retryAfterMs?: number }
    )
    expect(error?.httpStatus).toBeUndefined()
    expect(error?.retryAfterMs).toBeUndefined()
  })

  it("drains canonical terminal events emitted after the raw session-ended frame", async () => {
    let canonicalSubscriber!: (envelope: unknown) => void
    const unlistenCanonical = jest.fn()
    subscribeAgentEventsMock.mockImplementation(async (callback) => {
      canonicalSubscriber = callback
      return unlistenCanonical
    })
    const canonical = jest.fn()
    const promise = runAndCaptureAssistantReply(
      SESSION,
      "hi",
      { turnId: "terminal-order" },
      {
        onCanonicalEvent: canonical,
        timeoutMs: 1000,
      }
    )
    await flushUntilSubscribed()
    await flushMicrotasks()
    fire(assistantEvent("done"))
    fire(sessionEnded())
    expect(unlistenCanonical).not.toHaveBeenCalled()
    canonicalSubscriber({
      sessionId: SESSION,
      turnId: "terminal-order",
      attemptId: "a1",
      sequence: 0,
      event: { kind: "lifecycle", phase: "ended" },
    })
    await expect(promise).resolves.toMatchObject({ text: "done" })
    expect(canonical).toHaveBeenCalledWith({ kind: "lifecycle", phase: "ended" })
    expect(unlistenCanonical).toHaveBeenCalledTimes(1)
    subscribeAgentEventsMock.mockReset()
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
      code: "sidecar_exited",
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

  it("keeps the interrupted turn subscribed until its final usage arrives", async () => {
    const ac = new AbortController()
    const events: CaptureStreamEvent[] = []
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      signal: ac.signal,
      timeoutMs: 1_000,
      onEvent: (event) => events.push(event),
    })
    await flushUntilSubscribed()
    await flushMicrotasks()
    expect(sendPromptMock).toHaveBeenCalledTimes(1)
    fire(assistantEvent("partial reply"))

    ac.abort()
    await Promise.resolve()

    // Production unlisten detaches the transport handler. Deliver the sidecar's
    // interrupt tail only while capture is still subscribed, matching the real
    // event channel instead of calling a stale test closure directly.
    if (unlistenMock.mock.calls.length === 0) {
      fire({
        type: "event",
        sessionId: SESSION,
        event: {
          type: "result",
          subtype: "success",
          duration_ms: 20,
          is_error: false,
          uuid: "uuid-result-interrupted",
          session_id: SESSION,
          usage: { input_tokens: 1_200, output_tokens: 80, context_input_tokens: 900 },
        },
      } as unknown as ClaudeEvent)
      fire(sessionEnded())
    }

    await expect(promise).rejects.toMatchObject({ code: "aborted" })
    expect(events).toContainEqual({
      type: "usage",
      usage: expect.objectContaining({
        inputTokens: 1_200,
        outputTokens: 80,
        contextInputTokens: 900,
      }),
    })
    expect(unlistenMock).toHaveBeenCalledTimes(1)
  })

  it("hands the interrupted turn's text and provider snapshot to the caller", async () => {
    const ac = new AbortController()
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      signal: ac.signal,
      timeoutMs: 1_000,
    })
    await flushUntilSubscribed()
    await flushMicrotasks()
    fire(assistantEvent("partial reply"))
    ac.abort()
    await Promise.resolve()
    const conversationSnapshot = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "partial reply" },
    ]
    fire({ ...(sessionEnded() as object), conversationSnapshot } as unknown as ClaudeEvent)
    await expect(promise).rejects.toMatchObject({
      code: "aborted",
      partial: { text: "partial reply", conversationSnapshot },
    })
  })

  it("preserves bounded completed tool evidence on interruption without a written summary", async () => {
    const ac = new AbortController()
    const promise = runAndCaptureAssistantReply(SESSION, "research", undefined, {
      signal: ac.signal,
      timeoutMs: 1_000,
      preserveBudgetEvidence: true,
    })
    await flushUntilSubscribed()
    await flushMicrotasks()
    fire(toolUseEventWithId("done-read", "read", { file_path: "/completed.ts" }))
    fire(
      userToolResultEvent("done-read", [
        { type: "text", text: "DONE_FACT; NEXT_FILE=/remaining.ts" },
        { type: "image", source: { data: "DO_NOT_RETAIN_IMAGE_BYTES" } },
      ])
    )
    ac.abort()
    fire(sessionEnded())
    const error = await promise.catch((e) => e)
    expect(error).toMatchObject({ code: "aborted" })
    expect(error.partial.continuationContext).toContain("DONE_FACT")
    expect(error.partial.continuationContext).toContain("NEXT_FILE=/remaining.ts")
    expect(error.partial.continuationContext).not.toContain("DO_NOT_RETAIN_IMAGE_BYTES")
  })

  it.each([true, false])(
    "retains opted-in evidence when the aborted sidecar never terminates (preserve=%s)",
    async (preserveBudgetEvidence) => {
      jest.useFakeTimers()
      try {
        const ac = new AbortController()
        const promise = runAndCaptureAssistantReply(SESSION, "research", undefined, {
          signal: ac.signal,
          timeoutMs: 10_000,
          preserveBudgetEvidence,
        }).catch((error) => error)
        await flushUntilSubscribed()
        await flushMicrotasks()
        fire(assistantEvent("partial findings"))
        fire(toolUseEventWithId("done-read", "read", { file_path: "/completed.ts" }))
        fire(userToolResultEvent("done-read", "DONE_FACT; NEXT_FILE=/remaining.ts"))
        fire({
          type: "event",
          sessionId: SESSION,
          event: {
            type: "system",
            subtype: "compact_boundary",
            compact_metadata: { continuation_summary: "CHECKPOINT: completed first page" },
          },
        } as unknown as ClaudeEvent)
        ac.abort()
        expect(unlistenMock).not.toHaveBeenCalled()
        await jest.advanceTimersByTimeAsync(1_000)
        const error = await promise
        expect(error).toMatchObject({ code: "aborted", partial: { text: "partial findings" } })
        if (preserveBudgetEvidence) {
          expect(error.partial.continuationContext).toContain("DONE_FACT")
          expect(error.partial.continuationContext).toContain("NEXT_FILE=/remaining.ts")
          expect(error.partial.continuationContext).toContain("CHECKPOINT: completed first page")
        } else {
          expect(error.partial.continuationContext).toBeUndefined()
        }
        expect(interruptSessionMock).toHaveBeenCalledWith(SESSION)
        expect(unlistenMock).toHaveBeenCalledTimes(1)
        expect(jest.getTimerCount()).toBe(0)
      } finally {
        jest.useRealTimers()
      }
    }
  )

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

  it("rejects with session_error when no event arrives within timeoutMs and interrupts the sidecar", async () => {
    jest.useFakeTimers()
    try {
      const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 50 })
      // Allow the subscribe + sendPrompt promise chain to settle so the
      // watchdog timer is registered.
      await Promise.resolve()
      await Promise.resolve()
      jest.advanceTimersByTime(60)
      await expect(promise).rejects.toMatchObject({ code: "session_error" })
      expect(interruptSessionMock).toHaveBeenCalledWith(SESSION)
    } finally {
      jest.useRealTimers()
    }
  })

  // ── Idle (read) watchdog ──────────────────────────────────────────────
  it("keeps an active unbounded run alive beyond five minutes with idle protection enabled", async () => {
    jest.useFakeTimers()
    try {
      const promise = runAndCaptureAssistantReply(SESSION, "long research", undefined, {
        timeoutMs: 0,
        idleTimeoutMs: 120_000,
      })
      await flushUntilSubscribed()
      fire(assistantEvent("started"))
      for (let minute = 1; minute <= 6; minute++) {
        jest.advanceTimersByTime(60_000)
        fire(assistantEvent(`progress ${minute}`))
      }
      expect(interruptSessionMock).not.toHaveBeenCalled()
      fire(sessionEnded())
      await expect(promise).resolves.toMatchObject({ text: "progress 6" })
    } finally {
      jest.useRealTimers()
    }
  })

  const idlePermissionRequest = (): ClaudeEvent =>
    ({
      type: "permission_request",
      sessionId: SESSION,
      requestId: "req-1",
      toolName: "Bash",
      input: {},
    }) as unknown as ClaudeEvent

  it("interrupts the turn when the stream goes idle after it started (idleTimeoutMs)", async () => {
    jest.useFakeTimers()
    try {
      // Wall-clock off so ONLY the idle watchdog can fire.
      const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
        timeoutMs: 0,
        idleTimeoutMs: 100,
      })
      await flushUntilSubscribed()
      fire(assistantEvent("partial")) // arms the idle watchdog
      jest.advanceTimersByTime(150)
      await expect(promise).rejects.toMatchObject({ code: "session_error" })
      expect(interruptSessionMock).toHaveBeenCalledWith(SESSION)
    } finally {
      jest.useRealTimers()
    }
  })

  it("re-arms on each event so a steady stream never trips the idle watchdog", async () => {
    jest.useFakeTimers()
    try {
      const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
        timeoutMs: 0,
        idleTimeoutMs: 100,
      })
      await flushUntilSubscribed()
      fire(assistantEvent("a"))
      jest.advanceTimersByTime(60)
      fire(assistantEvent("ab")) // resets idle before 100ms
      jest.advanceTimersByTime(60)
      fire(assistantEvent("abc")) // resets idle again
      jest.advanceTimersByTime(60)
      // 180ms elapsed total, but never 100ms WITHOUT an event → still running.
      expect(interruptSessionMock).not.toHaveBeenCalled()
      fire(sessionEnded())
      await expect(promise).resolves.toMatchObject({ text: "abc" })
    } finally {
      jest.useRealTimers()
    }
  })

  // ── Turn correlation (stale-event isolation) ──────────────────────────
  it("payload-free progress survives canonical preference but genuine silence still times out", async () => {
    jest.useFakeTimers()
    subscribeAgentEventsMock.mockResolvedValue(jest.fn())
    try {
      const events: CaptureStreamEvent[] = []
      const promise = runAndCaptureAssistantReply(SESSION, "write a large patch", undefined, {
        timeoutMs: 0,
        idleTimeoutMs: 100,
        onEvent: (event) => events.push(event),
        onCanonicalEvent: () => {},
      }).catch((error) => error)
      await flushUntilSubscribed()
      await flushMicrotasks(20)
      expect(subscribeAgentEventsMock).toHaveBeenCalled()
      const turnId = (sendPromptMock.mock.calls.at(-1)?.[2] as { turnId: string }).turnId
      const ping = (sessionId = SESSION, turn = turnId) =>
        fire({
          type: "event",
          sessionId,
          turnId: turn,
          event: { type: "stream_event", event: { type: "ping" } },
        } as unknown as ClaudeEvent)
      for (let i = 0; i < 4; i++) {
        ping()
        await jest.advanceTimersByTimeAsync(60)
      }
      expect(interruptSessionMock).not.toHaveBeenCalled()
      expect(events).toEqual([])
      ping("other-session")
      ping(SESSION, "previous-turn")
      await jest.advanceTimersByTimeAsync(50)
      expect(await promise).toMatchObject({ code: "session_error" })
      expect(interruptSessionMock).toHaveBeenCalledWith(SESSION)
      expect(unlistenMock).toHaveBeenCalledTimes(1)
    } finally {
      subscribeAgentEventsMock.mockReset()
      jest.useRealTimers()
    }
  })

  // Read back the turn id this capture stamped on its own send.
  const stampedTurnId = (): string => {
    const opts = sendPromptMock.mock.calls.at(-1)?.[2] as { turnId?: string } | undefined
    if (!opts?.turnId) throw new Error("send was not stamped with a turnId")
    return opts.turnId
  }
  const withTurn = (evt: ClaudeEvent, turnId: string): ClaudeEvent =>
    ({ ...evt, turnId }) as unknown as ClaudeEvent

  it("ignores a session_ended left over from a PREVIOUS turn of the same session", async () => {
    // Regression (Lark connector, 2026-07-15): turn 1 hit its wall clock, and
    // the best-effort `interruptSession` it fired produced a `session_ended`
    // that arrived ~0.5s later — by which time turn 2 had subscribed on the
    // reused session id. Turn 2 consumed it and died 1.3s in with
    // "ended with no assistant text" while its own session was still booting.
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await flushUntilSubscribed()
    await flushMicrotasks()
    const mine = stampedTurnId()

    // The timed-out predecessor's interrupt lands here, stamped with ITS id.
    fire(withTurn(sessionEnded(), "turn-of-the-timed-out-predecessor"))
    await flushMicrotasks()

    // Discarded, not mistaken for our result — this turn still runs to its own
    // events. (Before the fix, `promise` had already rejected by now.)
    fire(withTurn(assistantEvent("Hello from this turn"), mine))
    fire(withTurn(sessionEnded(), mine))
    await expect(promise).resolves.toMatchObject({ text: "Hello from this turn" })
  })

  it("keeps events with no turnId so an unstamped sidecar still works", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await flushUntilSubscribed()
    await flushMicrotasks()
    // Absence means "can't tell which turn" — dropping these would strand every
    // turn against a sidecar that doesn't echo the id.
    fire(assistantEvent("unstamped"))
    fire(sessionEnded())
    await expect(promise).resolves.toMatchObject({ text: "unstamped" })
  })

  it("does not arm the idle watchdog before the first streamed event", async () => {
    jest.useFakeTimers()
    try {
      const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
        timeoutMs: 0,
        idleTimeoutMs: 100,
      })
      await flushUntilSubscribed()
      jest.advanceTimersByTime(500) // no event yet → watchdog not armed
      expect(interruptSessionMock).not.toHaveBeenCalled()
      fire(assistantEvent("late"))
      fire(sessionEnded())
      await expect(promise).resolves.toMatchObject({ text: "late" })
    } finally {
      jest.useRealTimers()
    }
  })

  it("pauses the idle watchdog while a permission request awaits the user", async () => {
    jest.useFakeTimers()
    try {
      const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
        timeoutMs: 0,
        idleTimeoutMs: 100,
      })
      await flushUntilSubscribed()
      fire(assistantEvent("thinking")) // arms idle
      jest.advanceTimersByTime(60)
      fire(idlePermissionRequest()) // pauses idle — human think-time is not a stall
      jest.advanceTimersByTime(500)
      expect(interruptSessionMock).not.toHaveBeenCalled()
      fire(assistantEvent("resumed")) // re-arms
      fire(sessionEnded())
      await expect(promise).resolves.toMatchObject({ text: "resumed" })
    } finally {
      jest.useRealTimers()
    }
  })

  it("pauses the idle watchdog while a tool executes, then re-arms after the result", async () => {
    jest.useFakeTimers()
    try {
      const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
        timeoutMs: 0,
        idleTimeoutMs: 100,
      })
      await flushUntilSubscribed()
      fire(assistantEvent("thinking")) // arms idle
      jest.advanceTimersByTime(60)
      // Tool starts: the provider stream is legitimately silent until it returns,
      // so a slow tool must NOT be read as a stalled stream.
      fire(toolUseEventWithId("tu_1", "bash", { command: "build" }))
      jest.advanceTimersByTime(500) // far past the 100ms idle window
      expect(interruptSessionMock).not.toHaveBeenCalled()
      // Tool result re-arms the watchdog; the model replies and the turn ends.
      fire(userToolResultEvent("tu_1", "built ok"))
      fire(assistantEvent("done"))
      fire(sessionEnded())
      await expect(promise).resolves.toMatchObject({ text: "done" })
    } finally {
      jest.useRealTimers()
    }
  })

  it("stays paused when a later snapshot repeats the in-flight tool_use (long dispatch never trips idle)", async () => {
    jest.useFakeTimers()
    try {
      const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
        timeoutMs: 0,
        idleTimeoutMs: 100,
      })
      await flushUntilSubscribed()
      fire(assistantEvent("thinking")) // arms idle
      fire(toolUseEventWithId("tu_1", "dispatch_agent", { subagentId: "x", prompt: "go" })) // pauses idle
      // The SDK re-includes the completed tool_use block in EVERY later assistant
      // snapshot. Such a stray repeat must NOT re-arm the watchdog while the tool
      // is in flight — a subagent dispatch is legitimately silent for minutes, and
      // re-arming here is exactly what tripped the main turn's idle watchdog.
      fire(toolUseEventWithId("tu_1", "dispatch_agent", { subagentId: "x", prompt: "go" }))
      jest.advanceTimersByTime(500) // far past the 100ms idle window
      expect(interruptSessionMock).not.toHaveBeenCalled()
      fire(userToolResultEvent("tu_1", "subagent done"))
      fire(assistantEvent("done"))
      fire(sessionEnded())
      await expect(promise).resolves.toMatchObject({ text: "done" })
    } finally {
      jest.useRealTimers()
    }
  })

  it("keeps the watchdog paused until the LAST of several parallel tools finishes", async () => {
    jest.useFakeTimers()
    try {
      const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
        timeoutMs: 0,
        idleTimeoutMs: 100,
      })
      await flushUntilSubscribed()
      fire(assistantEvent("thinking"))
      fire(toolUseEventWithId("tu_1", "bash", { command: "a" }))
      fire(toolUseEventWithId("tu_2", "bash", { command: "b" }))
      // First tool returns, second still running → the watchdog must stay paused.
      fire(userToolResultEvent("tu_1", "a done"))
      jest.advanceTimersByTime(500)
      expect(interruptSessionMock).not.toHaveBeenCalled()
      fire(userToolResultEvent("tu_2", "b done"))
      fire(assistantEvent("both done"))
      fire(sessionEnded())
      await expect(promise).resolves.toMatchObject({ text: "both done" })
    } finally {
      jest.useRealTimers()
    }
  })

  it("re-arms the idle watchdog once a permission decision is dispatched", async () => {
    jest.useFakeTimers()
    try {
      const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
        timeoutMs: 0,
        idleTimeoutMs: 100,
        onPermissionRequest: async () => ({ decision: "allow" }),
      })
      // Attach the rejection handler up front so the watchdog's reject is never
      // momentarily unhandled when the fake timer fires it.
      const rejection = expect(promise).rejects.toMatchObject({ code: "session_error" })
      await flushUntilSubscribed()
      fire(assistantEvent("thinking")) // arms idle
      fire(idlePermissionRequest()) // pauses idle while the responder decides
      // Flush the async responder (onPermissionRequest → approveTool → re-arm).
      await flushMicrotasks(10)
      // A post-approval provider stall (no further events) is now caught because
      // the watchdog was re-armed at decision dispatch (our fix), not left off.
      jest.advanceTimersByTime(150)
      await rejection
      expect(interruptSessionMock).toHaveBeenCalledWith(SESSION)
    } finally {
      jest.useRealTimers()
    }
  })

  it("keeps the watchdog paused while a sibling permission prompt still waits", async () => {
    // Two parallel calls each ask; answering the first must not start the idle
    // clock while the second is still on the user's screen.
    jest.useFakeTimers()
    try {
      const answers = new Map<string, (decision: { decision: "allow" }) => void>()
      const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
        timeoutMs: 0,
        idleTimeoutMs: 100,
        onPermissionRequest: (req) =>
          new Promise((resolve) => {
            answers.set(req.requestId, resolve)
          }),
      })
      const rejection = expect(promise).rejects.toMatchObject({ code: "session_error" })
      await flushUntilSubscribed()
      fire(assistantEvent("thinking")) // arms idle
      fire({ ...(idlePermissionRequest() as object), requestId: "req-a" } as ClaudeEvent)
      fire({ ...(idlePermissionRequest() as object), requestId: "req-b" } as ClaudeEvent)
      await flushMicrotasks(10)
      answers.get("req-a")!({ decision: "allow" })
      await flushMicrotasks(10)
      jest.advanceTimersByTime(500) // far past the idle window
      expect(interruptSessionMock).not.toHaveBeenCalled()
      // The last answer re-arms, so a stall after it is still caught.
      answers.get("req-b")!({ decision: "allow" })
      await flushMicrotasks(10)
      jest.advanceTimersByTime(150)
      await rejection
      expect(interruptSessionMock).toHaveBeenCalledWith(SESSION)
    } finally {
      jest.useRealTimers()
    }
  })

  it("does not restart the watchdog when an approved tool is still executing", async () => {
    jest.useFakeTimers()
    try {
      const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
        timeoutMs: 0,
        idleTimeoutMs: 100,
        onPermissionRequest: async () => ({ decision: "allow" }),
      })
      await flushUntilSubscribed()
      fire(assistantEvent("thinking"))
      fire(toolUseEventWithId("tu_1", "sandbox_bash", { command: "pnpm build" })) // pauses idle
      fire(idlePermissionRequest())
      await flushMicrotasks(10) // approved and dispatched
      jest.advanceTimersByTime(500) // the approved build runs far past the idle window
      expect(interruptSessionMock).not.toHaveBeenCalled()
      fire(userToolResultEvent("tu_1", "built"))
      fire(assistantEvent("done"))
      fire(sessionEnded())
      await expect(promise).resolves.toMatchObject({ text: "done" })
    } finally {
      jest.useRealTimers()
    }
  })

  it("stops the wall clock while a parked permission request waits (ADR-0224 A7)", async () => {
    jest.useFakeTimers()
    try {
      let answer!: (decision: { decision: "allow" }) => void
      const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
        timeoutMs: 1_000,
        pauseTimeoutWhileAwaitingPermission: true,
        onPermissionRequest: () =>
          new Promise((resolve) => {
            answer = resolve
          }),
      })
      await flushUntilSubscribed()
      fire(assistantEvent("thinking"))
      jest.advanceTimersByTime(400)
      fire(idlePermissionRequest())
      await Promise.resolve()
      await Promise.resolve()
      // A person takes far longer than the whole turn's budget to answer.
      jest.advanceTimersByTime(10_000)
      expect(interruptSessionMock).not.toHaveBeenCalled()
      answer({ decision: "allow" })
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(approveToolMock).toHaveBeenCalledWith(
        SESSION,
        "req-1",
        "allow",
        undefined,
        undefined,
        undefined,
        undefined
      )
      // The clock resumes with what was left (600ms), not a fresh budget.
      const rejection = expect(promise).rejects.toMatchObject({ code: "session_error" })
      jest.advanceTimersByTime(650)
      await rejection
      expect(interruptSessionMock).toHaveBeenCalledWith(SESSION)
    } finally {
      jest.useRealTimers()
    }
  })

  it("stops the wall clock while a browser submission's person decides (ADR-0239 phase 2b)", async () => {
    __resetCapturedTurnsForTesting()
    jest.useFakeTimers()
    try {
      const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
        timeoutMs: 1_000,
        pauseTimeoutWhileAwaitingPermission: true,
        onPermissionRequest: () => ({ decision: "deny" }),
      })
      await flushUntilSubscribed()
      fire(assistantEvent("thinking"))
      jest.advanceTimersByTime(400)
      const resume = capturedTurnOf(SESSION)!.holdWallClock!()
      jest.advanceTimersByTime(10_000)
      expect(interruptSessionMock).not.toHaveBeenCalled()
      resume()
      resume()
      // The clock resumes with what was left (600ms), once.
      const rejection = expect(promise).rejects.toMatchObject({ code: "session_error" })
      jest.advanceTimersByTime(650)
      await rejection
      expect(interruptSessionMock).toHaveBeenCalledWith(SESSION)
    } finally {
      jest.useRealTimers()
    }
  })

  it("keeps the wall clock running during a permission wait by default", async () => {
    jest.useFakeTimers()
    try {
      const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
        timeoutMs: 1_000,
        onPermissionRequest: () => new Promise(() => undefined),
      })
      const rejection = expect(promise).rejects.toMatchObject({ code: "session_error" })
      await flushUntilSubscribed()
      fire(idlePermissionRequest())
      jest.advanceTimersByTime(1_050)
      await rejection
    } finally {
      jest.useRealTimers()
    }
  })

  it("re-arms the idle watchdog once a tool-result review is dispatched", async () => {
    jest.useFakeTimers()
    try {
      const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
        timeoutMs: 0,
        idleTimeoutMs: 100,
        onToolResultReview: async () => undefined,
      })
      const rejection = expect(promise).rejects.toMatchObject({ code: "session_error" })
      await flushUntilSubscribed()
      fire(assistantEvent("thinking")) // arms idle
      // A tool-result review pauses idle while the responder runs, then re-arms.
      fire({
        type: "tool_result_review",
        sessionId: SESSION,
        reviewId: "rev-1",
        toolUseId: "tu_x",
        toolName: "bash",
        result: "out",
        isError: false,
      } as unknown as ClaudeEvent)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      jest.advanceTimersByTime(150)
      await rejection
      expect(interruptSessionMock).toHaveBeenCalledWith(SESSION)
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

  // ── Interceptor points on the send path (ADR-0189) ────────────────────

  const prepare = (registrationId: string, handler: unknown): void => {
    registerInterceptor({
      registrationId,
      pluginId: "p",
      pluginInstanceId: "p#1",
      generation: 1,
      realmId: "global",
      pointId: "model.request.prepare",
      semantic: "transform",
      trustTier: "community",
      order: {},
      timeoutMs: 1_000,
      handler: handler as never,
      source: "interceptors",
      runtime: "frontend",
    })
  }

  it("runs `model.request.prepare` even with the middleware flag off", async () => {
    // The around stage wraps the whole billed send and keeps its default-off
    // flag. A request transform is a different animal, and gating it with the
    // around stage would leave a registered interceptor silently dead.
    let seen: string | undefined
    prepare("p:peek", (value: { messages: Array<{ content: string }> }) => {
      seen = value.messages[0]?.content
      return value
    })

    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await flushUntilSubscribed()
    fire(assistantEvent("hello"))
    fire(sessionEnded())
    await promise
    expect(seen).toBe("hi")
  })

  it("sends what the prepare chain produced, not what it was handed", async () => {
    // The terminal used to close over the ORIGINAL prompt and ignore its
    // argument, so a rewrite survived the chain and was discarded one line
    // before the send.
    prepare("p:rewrite", (value: { messages: Array<{ content: string }> }) => ({
      ...value,
      messages: [{ ...value.messages[0], content: "rewritten" }],
    }))

    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await flushUntilSubscribed()
    await flushMicrotasks()
    fire(assistantEvent("hello"))
    fire(sessionEnded())
    await promise
    expect(sendPromptMock).toHaveBeenCalledWith(expect.anything(), "rewritten", expect.anything())
  })

  it("keeps a structured prompt intact when the chain did not touch the messages", async () => {
    prepare("p:model-only", (value: object) => ({ ...value, model: "swapped" }))

    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await flushUntilSubscribed()
    await flushMicrotasks()
    fire(assistantEvent("hello"))
    fire(sessionEnded())
    await promise
    // The prompt is untouched; only the declared option override lands.
    expect(sendPromptMock).toHaveBeenCalledWith(SESSION, "hi", expect.anything())
  })

  it("skips the whole chain when no interceptor is registered on either point", async () => {
    setChatMiddlewareExecutionEnabled(true)
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await flushUntilSubscribed()
    fire(assistantEvent("hello"))
    fire(sessionEnded())
    expect((await promise).text).toBe("hello")
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

  it("captures computed declarations and their values like the renderer (ADR-0240)", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await Promise.resolve()
    const total = { op: "multiply", args: [{ path: "/qty" }, { path: "/price" }] }
    fire(
      a2uiToolCall("mcp__a2ui-bridge__a2ui_create_surface", {
        surfaceId: "cart",
        surfaceType: "inline",
        computed: { "/total": total },
      })
    )
    fire(
      a2uiToolCall("mcp__a2ui-bridge__a2ui_data_model_update", {
        surfaceId: "cart",
        data: { qty: 2, price: 4 },
        computed: { "/half": { op: "divide", args: [{ path: "/total" }, 2] } },
      })
    )
    fire(
      a2uiToolCall(
        "mcp__a2ui-bridge__a2ui_data_model_update",
        { surfaceId: "cart", data: { qty: 9 }, computed: { "/total": { op: "eval" } } },
        { text: "ok" }
      )
    )
    fire(sessionEnded())
    const result = await promise
    const cart = result.a2uiSurfaces["cart"]
    expect(cart.dataModel).toEqual({ qty: 2, price: 4, total: 8, half: 4 })
    // The last update's computed map is invalid, so the whole call is refused,
    // as the renderer store refuses it: neither its data nor its declaration land.
    expect(cart.computed).toEqual({
      "/total": total,
      "/half": { op: "divide", args: [{ path: "/total" }, 2] },
    })
  })

  it("deep-merges captured data without losing nested siblings and honors replacement", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await Promise.resolve()
    fire(
      a2uiToolCall("mcp__a2ui-bridge__a2ui_data_model_update", {
        surfaceId: "nested",
        data: { profile: { name: "Ada", email: "a@example.test" }, draft: "keep" },
      })
    )
    fire(
      a2uiToolCall("mcp__a2ui-bridge__a2ui_data_model_update", {
        surfaceId: "nested",
        data: { profile: { name: "Grace" } },
      })
    )
    fire(
      a2uiToolCall("mcp__a2ui-bridge__a2ui_data_model_update", {
        surfaceId: "replace",
        data: { old: true },
      })
    )
    fire(
      a2uiToolCall("mcp__a2ui-bridge__a2ui_data_model_update", {
        surfaceId: "replace",
        data: { fresh: true },
        merge: false,
      })
    )
    fire(sessionEnded())
    const result = await promise
    expect(result.a2uiSurfaces.nested.dataModel).toEqual({
      profile: { name: "Grace", email: "a@example.test" },
      draft: "keep",
    })
    expect(result.a2uiSurfaces.replace.dataModel).toEqual({ fresh: true })
  })

  it("preserves a named captured root across child-first batches and child-only patches", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await Promise.resolve()
    fire(
      a2uiToolCall("mcp__a2ui-bridge__a2ui_update_components", {
        surfaceId: "named",
        components: [
          { id: "label", component: "Text", text: "before" },
          { id: "app", component: "Column", children: ["label"] },
        ],
      })
    )
    fire(
      a2uiToolCall("mcp__a2ui-bridge__a2ui_update_components", {
        surfaceId: "named",
        components: [{ id: "label", component: "Text", text: "after" }],
      })
    )
    fire(sessionEnded())
    const result = await promise
    expect(result.a2uiSurfaces.named.rootId).toBe("app")
    expect(result.a2uiSurfaces.named.components.label).toMatchObject({ text: "after" })
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

  it("keeps multi-round assistant text interleaved with tool calls and results", async () => {
    const events: CaptureStreamEvent[] = []
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      timeoutMs: 1_000,
      onEvent: (event) => events.push(event),
    })
    await flushUntilSubscribed()
    fire({
      type: "event",
      sessionId: SESSION,
      event: {
        type: "assistant",
        uuid: "uuid-text-tool",
        session_id: SESSION,
        message: {
          id: "m-text-tool",
          role: "assistant",
          content: [
            { type: "text", text: "I will inspect the project.\n\n" },
            { type: "tool_use", id: "tu-order", name: "read", input: { path: "README.md" } },
          ],
        },
      },
    } as unknown as ClaudeEvent)
    fire(userToolResultEvent("tu-order", "done"))
    fire({
      type: "event",
      sessionId: SESSION,
      event: {
        type: "assistant",
        uuid: "uuid-text-tool-2",
        session_id: SESSION,
        message: {
          id: "m-text-tool-2",
          role: "assistant",
          content: [
            { type: "text", text: "Next I will inspect the package.\n\n" },
            { type: "tool_use", id: "tu-order-2", name: "read", input: { path: "package.json" } },
          ],
        },
      },
    } as unknown as ClaudeEvent)
    fire(userToolResultEvent("tu-order-2", "done"))
    fire(
      assistantEvent("# Findings\n\nThe project is healthy.", {
        uuid: "uuid-final",
        messageId: "m-final",
      })
    )
    fire(sessionEnded())
    await promise

    expect(
      events
        .filter((event) => ["text-delta", "tool-call", "tool-result"].includes(event.type))
        .map((event) => event.type)
    ).toEqual([
      "text-delta",
      "tool-call",
      "tool-result",
      "text-delta",
      "tool-call",
      "tool-result",
      "text-delta",
    ])
  })

  it("forwards AI SDK stream-event markdown deltas before the canonical snapshot", async () => {
    const events: CaptureStreamEvent[] = []
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      timeoutMs: 1_000,
      onEvent: (event) => events.push(event),
    })
    await flushUntilSubscribed()
    fire({
      type: "event",
      sessionId: SESSION,
      event: {
        type: "stream_event",
        uuid: "stream-envelope-start",
        session_id: SESSION,
        event: { type: "message_start", message: { id: "m-stream" } },
      },
    } as unknown as ClaudeEvent)
    fire({
      type: "event",
      sessionId: SESSION,
      event: {
        type: "stream_event",
        uuid: "stream-envelope-delta",
        session_id: SESSION,
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "# Findings\n\nFirst paragraph." },
        },
      },
    } as unknown as ClaudeEvent)

    expect(events).toContainEqual({
      type: "text-delta",
      delta: "# Findings\n\nFirst paragraph.",
    })

    fire(
      assistantEvent("# Findings\n\nFirst paragraph.", {
        uuid: "uuid-stream-final",
        messageId: "m-stream",
      })
    )
    fire(sessionEnded())
    await promise
    expect(events.filter((event) => event.type === "text-delta")).toHaveLength(1)
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

  const apiRetry = (
    attempt: number,
    delayMs: number,
    extra: Record<string, unknown> = {}
  ): ClaudeEvent =>
    ({
      type: "event",
      sessionId: SESSION,
      event: {
        type: "system",
        subtype: "api_retry",
        uuid: `uuid-retry-${attempt}`,
        session_id: SESSION,
        attempt,
        max_retries: 10,
        retry_delay_ms: delayMs,
        error_status: null,
        error: "unknown",
        ...extra,
      },
    }) as unknown as ClaudeEvent

  it("streams the provider's retry ladder instead of going silent", async () => {
    // The Agent SDK backs off up to ~40s per step. With no projection for these
    // frames a headless consumer saw nothing at all for minutes and then a
    // stall message that named no cause.
    const events: CaptureStreamEvent[] = []
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      timeoutMs: 1_000,
      onEvent: (e) => events.push(e),
    })
    await flushUntilSubscribed()
    fire(apiRetry(1, 564))
    fire(apiRetry(2, 1_089, { error_status: 503, error: "overloaded_error" }))
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await promise
    expect(events.filter((e) => e.type === "retry")).toEqual([
      {
        type: "retry",
        phase: "scheduled",
        attempt: 1,
        maxRetries: 10,
        code: "api_retry",
        delayMs: 564,
        message: "unknown",
      },
      {
        type: "retry",
        phase: "scheduled",
        attempt: 2,
        maxRetries: 10,
        code: "api_retry",
        delayMs: 1_089,
        status: 503,
        message: "overloaded_error",
      },
    ])
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
    expect(toolCalls[0]).toMatchObject({ type: "tool-call", toolName: "ls", id: "tu_1" })
  })

  it("waits for the sealed snapshot: an input-streaming block is not the call", async () => {
    // The AI SDK adapter snapshots the block from `tool-input-start` with
    // `input: {}` and `state: "input-streaming"`. The sealed snapshot with the
    // real arguments follows. First-seen dedup alone kept the empty one.
    const streamingSnapshot: ClaudeEvent = {
      type: "event",
      sessionId: SESSION,
      event: {
        type: "assistant",
        uuid: "uuid-tu",
        session_id: SESSION,
        message: {
          id: "m-tu",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu_s",
              name: "dispatch_agent",
              input: {},
              state: "input-streaming",
            },
          ],
        },
      },
    } as unknown as ClaudeEvent
    const events: Array<{ type: string; input?: Record<string, unknown> }> = []
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      timeoutMs: 1_000,
      onEvent: (e) => events.push(e as { type: string; input?: Record<string, unknown> }),
    })
    await Promise.resolve()
    fire(streamingSnapshot)
    fire(streamingSnapshot)
    fire(toolUseEventWithId("tu_s", "dispatch_agent", { subagentId: "Explore", prompt: "go" }))
    fire(toolUseEventWithId("tu_s", "dispatch_agent", { subagentId: "Explore", prompt: "go" }))
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await promise
    const toolCalls = events.filter((e) => e.type === "tool-call")
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]).toMatchObject({
      type: "tool-call",
      id: "tu_s",
      input: { subagentId: "Explore", prompt: "go" },
    })
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

  it("retains bounded tool evidence when research hits its budget without a written summary", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "research", undefined, {
      timeoutMs: 1_000,
      preserveBudgetEvidence: true,
    })
    await Promise.resolve()
    for (let index = 0; index < 35; index++) {
      const id = `read-${index}`
      fire(toolUseEventWithId(id, "read", { file_path: `/chapter-${index}` }))
      fire(
        userToolResultEvent(id, [
          { type: "text", text: `FACT_${index}; NEXT_FILE=/chapter-${index + 1}` },
          { type: "image", source: { data: "DO_NOT_RETAIN_IMAGE_BYTES" } },
        ])
      )
    }
    fire({
      type: "event",
      sessionId: SESSION,
      event: { type: "result", subtype: "error_max_turns", is_error: true },
    } as unknown as ClaudeEvent)
    fire(sessionEnded())
    const result = await promise
    expect(result.budgetContinuationContext).toContain("FACT_0;")
    expect(result.budgetContinuationContext).toContain("FACT_34;")
    expect(result.budgetContinuationContext).toContain("NEXT_FILE=/chapter-35")
    expect(result.budgetContinuationContext).toContain("omitted")
    expect(result.budgetContinuationContext).not.toContain("FACT_1;")
    expect(result.budgetContinuationContext).not.toContain("DO_NOT_RETAIN_IMAGE_BYTES")
    expect(result.budgetContinuationContext!.length).toBeLessThan(70_000)
  })

  it("keeps a useful result excerpt even when the tool input exceeds the evidence limit", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "research", undefined, {
      timeoutMs: 1_000,
      preserveBudgetEvidence: true,
    })
    await Promise.resolve()
    fire(toolUseEventWithId("large", "search", { query: "x".repeat(10_000) }))
    fire(userToolResultEvent("large", "OBSERVED_RESULT " + "y".repeat(10_000)))
    fire({
      type: "event",
      sessionId: SESSION,
      event: { type: "result", subtype: "error_max_turns", is_error: true },
    } as unknown as ClaudeEvent)
    fire(sessionEnded())
    const result = await promise
    expect(result.budgetContinuationContext).toContain("OBSERVED_RESULT")
    expect(result.budgetContinuationContext).toContain("truncated")
    expect(result.budgetContinuationContext!.length).toBeLessThan(2300)
  })

  it("keeps unsummarized source bodies within the retained budget and retires checkpointed tool results", async () => {
    const promise = runAndCaptureAssistantReply(
      SESSION,
      "research",
      {
        compaction: { enabled: true, postCompactionTokenBudget: 5000 },
      },
      { timeoutMs: 1000, preserveBudgetEvidence: true }
    )
    await flushUntilSubscribed()
    fire(toolUseEventWithId("covered", "read", { file_path: "/covered.ts" }))
    fire(userToolResultEvent("covered", "OLD_RAW_SOURCE ".repeat(300)))
    fire({
      type: "event",
      sessionId: SESSION,
      event: {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: {
          continuation_summary: "COMMITTED_BEHAVIOR covered.ts:1",
          continuation_summary_chars: 31,
          continuation_tool_result_ids: ["covered"],
          post_compaction_token_budget: 5000,
          projected_input_tokens: 4000,
          post_tokens: 2000,
        },
      },
    } as unknown as ClaudeEvent)
    fire(toolUseEventWithId("tail", "read", { file_path: "/tail.ts" }))
    fire(
      userToolResultEvent(
        "tail",
        "heading ".repeat(300) + "UNCOMMITTED_MIDDLE_BEHAVIOR" + " footer".repeat(300)
      )
    )
    fire({
      type: "event",
      sessionId: SESSION,
      event: { type: "result", subtype: "error_max_turns", is_error: true },
    } as unknown as ClaudeEvent)
    fire(sessionEnded())
    const result = await promise
    expect(result.budgetContinuationContext).toContain("COMMITTED_BEHAVIOR")
    expect(result.budgetContinuationContext).toContain("UNCOMMITTED_MIDDLE_BEHAVIOR")
    expect(result.budgetContinuationContext).not.toContain("OLD_RAW_SOURCE")
    expect(result.budgetContinuationContext).toContain('"file_path":"/covered.ts"')
    expect(result.budgetContinuationContext).toContain('"checkpointed":true')
    expect(result.budgetContinuationContext!.length).toBeLessThan(12000)
  })

  it("keeps the aggregate continuation bounded by an explicit retained cap", async () => {
    const promise = runAndCaptureAssistantReply(
      SESSION,
      "research",
      {
        compaction: { enabled: true, postCompactionTokenBudget: 1000 },
      },
      { timeoutMs: 1000, preserveBudgetEvidence: true }
    )
    await flushUntilSubscribed()
    fire({
      type: "event",
      sessionId: SESSION,
      event: {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: {
          continuation_summary: "VERIFIED_STATE",
          post_compaction_token_budget: 10000,
        },
      },
    } as unknown as ClaudeEvent)
    for (const id of ["FIRST", "MIDDLE", "LATEST"]) {
      fire(toolUseEventWithId(id, "read", { file_path: `/${id}.ts` }))
      fire(userToolResultEvent(id, `${id}_HEADING` + " body".repeat(350) + `${id}_FOOTER`))
    }
    fire({
      type: "event",
      sessionId: SESSION,
      event: { type: "result", subtype: "error_max_turns", is_error: true },
    } as unknown as ClaudeEvent)
    fire(sessionEnded())
    const result = await promise
    expect(result.budgetContinuationContext).toContain("FIRST_HEADING")
    expect(result.budgetContinuationContext).toContain("LATEST_FOOTER")
    expect(result.budgetContinuationContext).toContain("omitted")
    expect(result.budgetContinuationContext).toContain("truncated")
    expect(result.budgetContinuationContext).not.toContain("MIDDLE_HEADING")
    expect(result.budgetContinuationContext!.length).toBeLessThan(4000)
  })

  it("restores executed-read headers after an omitted raw result is covered by a checkpoint", async () => {
    const promise = runAndCaptureAssistantReply(
      SESSION,
      "research",
      {
        compaction: { enabled: true, postCompactionTokenBudget: 1000 },
      },
      { timeoutMs: 1000, preserveBudgetEvidence: true }
    )
    await flushUntilSubscribed()
    for (const id of ["FIRST", "MIDDLE", "LATEST"]) {
      fire(toolUseEventWithId(id, "read", { file_path: `/${id}.ts` }))
      fire(userToolResultEvent(id, `${id}_RAW` + " body".repeat(190)))
    }
    fire(toolUseEventWithId("MIDDLE", "read", { file_path: "/MIDDLE.ts" }))
    fire({
      type: "event",
      sessionId: SESSION,
      event: {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: {
          continuation_summary: "FIRST and MIDDLE established findings",
          continuation_tool_result_ids: ["FIRST", "MIDDLE"],
          post_compaction_token_budget: 1000,
        },
      },
    } as unknown as ClaudeEvent)
    fire({
      type: "event",
      sessionId: SESSION,
      event: { type: "result", subtype: "error_max_turns", is_error: true },
    } as unknown as ClaudeEvent)
    fire(sessionEnded())
    const result = await promise
    expect(result.budgetContinuationContext).toContain(
      '"file_path":"/MIDDLE.ts"},"failed":false,"checkpointed":true'
    )
    expect(result.budgetContinuationContext).not.toContain("MIDDLE_RAW")
    expect(result.budgetContinuationContext).not.toContain("omitted")
    expect(result.budgetContinuationContext).toContain("LATEST_RAW")
  })

  it("keeps both the source heading and footer continuation path in a bounded long read", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "research", undefined, {
      timeoutMs: 1_000,
      preserveBudgetEvidence: true,
    })
    await Promise.resolve()
    fire(toolUseEventWithId("long-read", "read", { file_path: "/source.ts" }))
    fire(
      userToolResultEvent(
        "long-read",
        "VERIFIED_SOURCE_HEADING\n" +
          "source body\n".repeat(3000) +
          "\nSOURCE_FACT: complete page\nNEXT_FILE=/unread-source.ts"
      )
    )
    fire({
      type: "event",
      sessionId: SESSION,
      event: { type: "result", subtype: "error_max_turns", is_error: true },
    } as unknown as ClaudeEvent)
    fire(sessionEnded())
    const result = await promise
    expect(result.budgetContinuationContext).toContain("VERIFIED_SOURCE_HEADING")
    expect(result.budgetContinuationContext).toContain("SOURCE_FACT: complete page")
    expect(result.budgetContinuationContext).toContain("NEXT_FILE=/unread-source.ts")
    expect(result.budgetContinuationContext).toContain("truncated")
    expect(result.budgetContinuationContext!.length).toBeLessThan(2300)
  })

  it("carries the latest compacted research checkpoint into budget continuation without tool output", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "research", undefined, {
      timeoutMs: 1_000,
      preserveBudgetEvidence: true,
    })
    await flushUntilSubscribed()
    for (const checkpoint of [
      "OUTDATED_CHECKPOINT",
      "SOURCE_FACT: verified guard; pending: cancellation; alice@example.com " +
        "x".repeat(100_000),
    ]) {
      fire({
        type: "event",
        sessionId: SESSION,
        event: {
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { continuation_summary: checkpoint },
        },
      } as unknown as ClaudeEvent)
    }
    fire({
      type: "event",
      sessionId: SESSION,
      event: { type: "result", subtype: "error_max_turns", is_error: true },
    } as unknown as ClaudeEvent)
    fire(sessionEnded())
    const result = await promise
    expect(result.budgetContinuationContext).toContain("SOURCE_FACT: verified guard")
    expect(result.budgetContinuationContext).toContain("pending: cancellation")
    expect(result.budgetContinuationContext).toContain("untrusted")
    expect(result.budgetContinuationContext).toContain("truncated")
    expect(result.budgetContinuationContext).not.toContain("OUTDATED_CHECKPOINT")
    expect(result.budgetContinuationContext).not.toContain("alice@example.com")
    expect(result.budgetContinuationContext!.length).toBeLessThan(34_000)
  })

  it("retains the middle of an adaptive checkpoint larger than the legacy character cap", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "research", undefined, {
      timeoutMs: 1000,
      preserveBudgetEvidence: true,
    })
    await flushUntilSubscribed()
    const checkpoint = "x".repeat(20000) + "EXACT_MIDDLE_EVIDENCE" + "y".repeat(20000)
    fire({
      type: "event",
      sessionId: SESSION,
      event: {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { continuation_summary: checkpoint, checkpoint_token_budget: 16000 },
      },
    } as unknown as ClaudeEvent)
    fire({
      type: "event",
      sessionId: SESSION,
      event: { type: "result", subtype: "error_max_turns", is_error: true },
    } as unknown as ClaudeEvent)
    fire(sessionEnded())
    const result = await promise
    expect(result.budgetContinuationContext).toContain(checkpoint)
    expect(result.budgetContinuationContext).not.toContain("checkpoint truncated")
  })

  it("keeps a valid near-cap checkpoint including its serialized wrapper on budget stop", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "research", undefined, {
      timeoutMs: 1000,
      preserveBudgetEvidence: true,
    })
    await flushUntilSubscribed()
    const raw = `<research-progress>${JSON.stringify({
      goal: "Inspect code",
      constraints: [],
      items: [{ id: "work", status: "done", summary: "", evidence: [] }],
    })}</research-progress>`
    const progress = raw.replace('"summary":""', `"summary":"${"x".repeat(1201 - raw.length)}"`)
    expect(progress).toHaveLength(1201)
    const checkpoint = `<conversation-summary v="1">\nSummary of earlier conversation (compacted to save context):\n${progress}\n</conversation-summary>`
    fire({
      type: "event",
      sessionId: SESSION,
      event: {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: {
          continuation_summary: checkpoint,
          continuation_summary_chars: checkpoint.length,
          checkpoint_token_budget: 300,
        },
      },
    } as unknown as ClaudeEvent)
    fire({
      type: "event",
      sessionId: SESSION,
      event: { type: "result", subtype: "error_max_turns", is_error: true },
    } as unknown as ClaudeEvent)
    fire(sessionEnded())
    const result = await promise
    expect(result.budgetContinuationContext).toContain(checkpoint)
    expect(result.budgetContinuationContext).not.toContain("checkpoint truncated")
  })

  it.each([
    [true, "success"],
    [false, "error_max_turns"],
  ] as const)(
    "omits continuation evidence with opt-in=%s and subtype=%s",
    async (preserveBudgetEvidence, subtype) => {
      const promise = runAndCaptureAssistantReply(SESSION, "research", undefined, {
        timeoutMs: 1_000,
        preserveBudgetEvidence,
      })
      await Promise.resolve()
      fire(toolUseEventWithId("read", "read", { file_path: "/chapter" }))
      fire(userToolResultEvent("read", "PRIVATE_RESULT"))
      fire({
        type: "event",
        sessionId: SESSION,
        event: { type: "result", subtype, is_error: subtype !== "success" },
      } as unknown as ClaudeEvent)
      fire(sessionEnded())
      expect((await promise).budgetContinuationContext).toBeUndefined()
    }
  )

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
      id: "tu_9",
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

  it("tells the global post-tool interceptors the call's outcome and turn", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "hi", { turnId: "turn-7" } as never, {
      timeoutMs: 1_000,
    })
    await Promise.resolve()
    fire(toolUseEventWithId("tu_e", "Bash", { command: "ls" }))
    fire(toolResultReview("rev_e", "tu_e", "Bash", "ENOENT", true))
    await Promise.resolve()
    await Promise.resolve()
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await promise
    expect(postToolUseMock).toHaveBeenCalledWith("Bash", { command: "ls" }, "ENOENT", SESSION, {
      isError: true,
      turnId: "turn-7",
    })
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

  it("capture responders receive SDK hints and cannot persist a suppressed grant", async () => {
    const responder = jest.fn(() => ({ decision: "allow_always" as const }))
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      onPermissionRequest: responder,
    })
    await flushUntilSubscribed()
    fire({
      ...permissionRequest("suppressed", "Read", {}),
      defaultToNo: true,
      suppressAlwaysAllowRule: true,
    } as never)
    await flushMicrotasks()
    expect(responder).toHaveBeenCalledWith(
      expect.objectContaining({ defaultToNo: true, suppressAlwaysAllowRule: true })
    )
    expect(approveToolMock).toHaveBeenCalledWith(
      SESSION,
      "suppressed",
      "allow",
      undefined,
      undefined,
      undefined,
      undefined
    )
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await promise
  })

  it("applies the global plugin firewall before asking the capture owner", async () => {
    preToolUseMock.mockResolvedValueOnce({ action: "deny", reason: "blocked" } as never)
    const responder = jest.fn(() => ({ decision: "allow" as const }))
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      onPermissionRequest: responder,
    })
    await flushUntilSubscribed()
    fire(permissionRequest("blocked", "Bash", {}))
    await flushMicrotasks()
    expect(responder).not.toHaveBeenCalled()
    expect(approveToolMock).toHaveBeenCalledWith(
      SESSION,
      "blocked",
      "deny",
      "blocked",
      undefined,
      undefined,
      { authority: "policy-deny" }
    )
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await promise
  })

  it("shows rewritten input to the owner and dispatches that exact approved input", async () => {
    preToolUseMock.mockResolvedValueOnce({
      action: "modify",
      modifiedArgs: { path: "safe" },
    } as never)
    const responder = jest.fn(() => ({ decision: "allow" as const }))
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      onPermissionRequest: responder,
    })
    await flushUntilSubscribed()
    fire(permissionRequest("rewritten", "Read", { path: "original" }))
    await flushMicrotasks()
    expect(responder).toHaveBeenCalledWith(expect.objectContaining({ input: { path: "safe" } }))
    expect(approveToolMock).toHaveBeenCalledWith(
      SESSION,
      "rewritten",
      "allow",
      undefined,
      { path: "safe" },
      undefined,
      undefined
    )
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await promise
  })

  it("a per-call tool ignores a plugin modify and never persists an always-allow", async () => {
    preToolUseMock.mockResolvedValueOnce({
      action: "modify",
      modifiedArgs: { credentialId: "other" },
    } as never)
    const responder = jest.fn(() => ({ decision: "allow_always" as const }))
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      onPermissionRequest: responder,
    })
    await flushUntilSubscribed()
    fire({
      ...permissionRequest("per-call", "mcp__cognia-plugin-tools__browser_fill_credential", {
        credentialId: "c1",
      }),
      requiresPerCallApproval: true,
    } as never)
    await flushMicrotasks()
    // The approver sees the model's own input, not the plugin's rewrite.
    expect(responder).toHaveBeenCalledWith(
      expect.objectContaining({ input: { credentialId: "c1" }, requiresPerCallApproval: true })
    )
    expect(approveToolMock).toHaveBeenCalledWith(
      SESSION,
      "per-call",
      "allow",
      undefined,
      undefined,
      undefined,
      undefined
    )
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await promise
  })

  it("a plugin can still deny a per-call tool", async () => {
    preToolUseMock.mockResolvedValueOnce({ action: "deny", reason: "no" } as never)
    const responder = jest.fn(() => ({ decision: "allow" as const }))
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      onPermissionRequest: responder,
    })
    await flushUntilSubscribed()
    fire({
      ...permissionRequest("per-call-deny", "mcp__cognia-plugin-tools__browser_set_files", {}),
      requiresPerCallApproval: true,
    } as never)
    await flushMicrotasks()
    expect(responder).not.toHaveBeenCalled()
    expect(approveToolMock).toHaveBeenCalledWith(
      SESSION,
      "per-call-deny",
      "deny",
      "no",
      undefined,
      undefined,
      { authority: "policy-deny" }
    )
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await promise
  })

  it("owns response events until settlement and answers repeated asks only once", async () => {
    const responder = jest.fn(() => ({ decision: "allow" as const }))
    const promise = runAndCaptureAssistantReply(
      SESSION,
      "hi",
      { turnId: "owned-turn" },
      {
        timeoutMs: 1_000,
        onPermissionRequest: responder,
      }
    )
    await flushUntilSubscribed()
    const request = { ...permissionRequest("req-once", "Read", {}), turnId: "owned-turn" }
    expect(hasCaptureResponder(request)).toBe(true)
    fire(request)
    fire(request)
    await flushMicrotasks()
    expect(responder).toHaveBeenCalledTimes(1)
    expect(approveToolMock).toHaveBeenCalledTimes(1)
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await promise
    expect(hasCaptureResponder(request)).toBe(false)
  })

  it("records the turn's outbound planning and responder for its session while it runs", async () => {
    // An earlier test may leave its own capture unsettled.
    __resetCapturedTurnsForTesting()
    const responder = jest.fn(() => ({ decision: "deny" as const }))
    const origin = { rootSessionId: "task:t1", instructionEpoch: "task-epoch" }
    const promise = runAndCaptureAssistantReply(
      SESSION,
      "hi",
      { turnId: "captured-turn" },
      {
        timeoutMs: 1_000,
        onPermissionRequest: responder,
        outboundPolicy: { unattended: true, origin },
      }
    )
    await flushUntilSubscribed()
    const turn = capturedTurnOf(SESSION)
    expect(turn).toMatchObject({
      turnId: "captured-turn",
      outboundPolicy: { unattended: true, origin },
    })
    // A browser submission inside the turn asks the turn's own person.
    await expect(
      Promise.resolve(
        turn?.respond?.(
          permissionRequest("browser-1", "browser_submit", {}) as unknown as PermissionRequestEvent
        )
      )
    ).resolves.toEqual({ decision: "deny" })
    expect(responder).toHaveBeenCalledTimes(1)
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await promise
    expect(capturedTurnOf(SESSION)).toBeUndefined()
  })

  it("records a turn with no responder as unattended, with nobody to ask", async () => {
    __resetCapturedTurnsForTesting()
    const promise = runAndCaptureAssistantReply(
      SESSION,
      "hi",
      { turnId: "quiet-turn" },
      {
        timeoutMs: 1_000,
      }
    )
    await flushUntilSubscribed()
    expect(capturedTurnOf(SESSION)).toEqual({
      turnId: "quiet-turn",
      outboundPolicy: { unattended: true },
      holdWallClock: expect.any(Function),
    })
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await promise
    expect(capturedTurnOf(SESSION)).toBeUndefined()
  })

  it("releases response ownership after a failed send", async () => {
    sendPromptMock.mockRejectedValueOnce(new Error("offline"))
    const promise = runAndCaptureAssistantReply(
      SESSION,
      "hi",
      { turnId: "owned-turn" },
      {
        onPermissionRequest: () => ({ decision: "deny" }),
      }
    )
    await expect(promise).rejects.toMatchObject({ code: "send_failed" })
    expect(
      hasCaptureResponder({
        type: "permission_request",
        sessionId: SESSION,
        turnId: "owned-turn",
      })
    ).toBe(false)
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
    await flushMicrotasks()
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await promise
    expect(approveToolMock).toHaveBeenCalledWith(
      SESSION,
      "req-1",
      "allow",
      undefined,
      { url: "<REDACTED>" },
      undefined,
      undefined
    )
  })

  it("never applies an approval that resolves after cancellation", async () => {
    const controller = new AbortController()
    let approve!: (decision: { decision: "allow" }) => void
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      signal: controller.signal,
      onPermissionRequest: () =>
        new Promise((resolve) => {
          approve = resolve
        }),
    })
    await Promise.resolve()
    fire(permissionRequest("stale-request", "bash", { command: "build" }))
    await flushMicrotasks()
    controller.abort()
    const rejected = expect(promise).rejects.toMatchObject({ code: "aborted" })
    approve({ decision: "allow" })
    await Promise.resolve()
    await rejected
    expect(approveToolMock).not.toHaveBeenCalled()
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
    await flushMicrotasks()
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await promise
    expect(approveToolMock).toHaveBeenCalledWith(
      SESSION,
      "req-2",
      "deny",
      "permission responder failed",
      undefined,
      undefined,
      { authority: "system" }
    )
  })
})

describe("connector permission attribution", () => {
  const fixture = createDbTestFixture({ seeded: false })
  let unregister: () => void
  beforeAll(fixture.initialize)
  beforeEach(async () => {
    await fixture.restore()
    unregister = registerImElicitationContext({
      sessionId: SESSION,
      adapterId: "lark",
      conversationKey: "chat-a",
      conversationRef: { platform: "lark", adapterId: "lark", conversationId: "chat-a" },
      runId: "run-a",
      initiatorUserId: "initiator-a",
    })
  })
  afterEach(() => unregister())
  afterAll(fixture.dispose)

  it.each(["allow", "deny"] as const)(
    "attributes a connector %s to the human once",
    async (decision) => {
      const context = {
        hostId: "host-a",
        originDeviceId: "device-a",
        sessionId: SESSION,
        generation: 1,
        requestId: "remote-a",
        issuedAt: 1,
        expiresAt: 2,
      }
      const responder = jest.fn(async () => {
        await getDb().executionRunInterrupts.put({
          id: "tool-interrupt:run-a:approval-a",
          runId: "run-a",
          type: "tool_approval",
          status: decision === "allow" ? "approved" : "denied",
          title: "issue_list",
          expiresAt: 10_000,
          createdAt: 1,
          resolvedBy: { remoteUserId: "operator-a" },
        })
        return { decision }
      })
      const running = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
        onPermissionRequest: responder,
      })
      await flushUntilSubscribed()
      const request = {
        type: "permission_request",
        sessionId: SESSION,
        requestId: "approval-a",
        toolName: "issue_list",
        input: {},
        remoteExecutionContext: context,
      } as unknown as ClaudeEvent
      fire(request)
      fire(request)
      for (let attempt = 0; attempt < 100 && approveToolMock.mock.calls.length === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      expect(responder).toHaveBeenCalledTimes(1)
      expect(approveToolMock).toHaveBeenCalledTimes(1)
      expect(approveToolMock).toHaveBeenCalledWith(
        SESSION,
        "approval-a",
        decision,
        undefined,
        undefined,
        context,
        { authority: "human", actor: { kind: "connector-user", id: "operator-a" } }
      )
      fire(assistantEvent("done"))
      fire(sessionEnded())
      await running
    }
  )

  it.each([
    [{ decision: "allow" }, "policy-rule"],
    [{ decision: "deny", message: "failed to surface approval card" }, "policy-deny"],
    [{ decision: "deny", message: "approval timed out" }, "timeout"],
  ] as const)(
    "does not attribute an automatic decision to a human: %j",
    async (decision, authority) => {
      const running = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
        onPermissionRequest: async () => decision,
      })
      await flushUntilSubscribed()
      fire({
        type: "permission_request",
        sessionId: SESSION,
        requestId: "automatic",
        toolName: "issue_list",
        input: {},
      } as unknown as ClaudeEvent)
      for (let attempt = 0; attempt < 100 && approveToolMock.mock.calls.length === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      expect(approveToolMock.mock.calls[0]?.[6]).toEqual({ authority })
      fire(assistantEvent("done"))
      fire(sessionEnded())
      await running
    }
  )

  it("preserves explicit responder attribution", async () => {
    const attribution = {
      authority: "human" as const,
      actor: { kind: "connector-user" as const, id: "reviewer-a" },
    }
    const running = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      onPermissionRequest: () => ({ decision: "allow", attribution }),
    })
    await flushUntilSubscribed()
    fire({
      type: "permission_request",
      sessionId: SESSION,
      requestId: "explicit",
      toolName: "issue_list",
      input: {},
    } as unknown as ClaudeEvent)
    await flushMicrotasks(10)
    expect(approveToolMock.mock.calls[0]?.[6]).toBe(attribution)
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await running
  })
})

describe("outbound calls (ADR-0239)", () => {
  const SEND = "mcp__cognia-plugin-tools__connectors_send_message"
  const policy = { unattended: true, origin: { rootSessionId: "task:t1" } }
  const permissionRequest = (requestId: string, toolName: string, input: unknown) =>
    ({
      type: "permission_request",
      sessionId: SESSION,
      requestId,
      toolUseID: "tu-1",
      toolName,
      input,
    }) as unknown as ClaudeEvent

  beforeEach(() => {
    answerWithOutboundPolicyMock.mockReset()
    recordOutboundShadowMock.mockClear()
  })

  it("lets the outbound policy answer first, on the input the plugin rewrote", async () => {
    preToolUseMock.mockResolvedValueOnce({
      action: "modify",
      modifiedArgs: { conversationKey: "lark:bot-a:oc_1", text: "redacted" },
    } as never)
    answerWithOutboundPolicyMock.mockImplementation(async (request, _options, respond) =>
      respond({ ...request, requiresPerCallApproval: true })
    )
    const responder = jest.fn(async () => ({ decision: "allow" as const }))
    const running = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      onPermissionRequest: responder,
      outboundPolicy: policy,
    })
    await flushUntilSubscribed()
    fire(permissionRequest("send", SEND, { conversationKey: "lark:bot-a:oc_1", text: "raw" }))
    for (let i = 0; i < 100 && approveToolMock.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    expect(answerWithOutboundPolicyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "send",
        input: expect.objectContaining({ text: "redacted" }),
      }),
      policy,
      expect.any(Function)
    )
    expect(responder).toHaveBeenCalledWith(
      expect.objectContaining({ requiresPerCallApproval: true })
    )
    expect(approveToolMock.mock.calls[0]?.slice(0, 3)).toEqual([SESSION, "send", "allow"])
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await running
  })

  it("does not plan a tool that is not outbound", async () => {
    const responder = jest.fn(async () => ({ decision: "allow" as const }))
    const running = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      onPermissionRequest: responder,
      outboundPolicy: policy,
    })
    await flushUntilSubscribed()
    fire(permissionRequest("read", "Read", {}))
    await flushMicrotasks(10)
    expect(answerWithOutboundPolicyMock).not.toHaveBeenCalled()
    expect(responder).toHaveBeenCalledTimes(1)
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await running
  })

  it("records a shadow observation for a session it answers, and only then", async () => {
    const event = {
      type: "explicit_tool_allowed",
      sessionId: SESSION,
      toolName: SEND,
      input: {},
      permissionClass: "outbound",
    } as unknown as ClaudeEvent
    const answering = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      onPermissionRequest: async () => ({ decision: "allow" }),
      outboundPolicy: policy,
    })
    await flushUntilSubscribed()
    fire(event)
    for (let i = 0; i < 50 && recordOutboundShadowMock.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    expect(recordOutboundShadowMock).toHaveBeenCalledWith(event, policy)
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await answering

    recordOutboundShadowMock.mockClear()
    captured = null
    const watching = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await flushUntilSubscribed()
    fire(event)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(recordOutboundShadowMock).not.toHaveBeenCalled()
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await watching
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

describe("retryFromInner", () => {
  it("maps an api_retry system message to the typed retry event", () => {
    expect(
      retryFromInner({
        type: "system",
        subtype: "api_retry",
        attempt: 3,
        max_retries: 10,
        retry_delay_ms: 2_495,
        error_status: 429,
        error: "rate_limit_error",
      })
    ).toEqual({
      type: "retry",
      phase: "scheduled",
      attempt: 3,
      maxRetries: 10,
      code: "api_retry",
      delayMs: 2_495,
      status: 429,
      message: "rate_limit_error",
    })
  })

  it("omits the status the SDK reports as null on a transport failure", () => {
    // An unreachable endpoint has no HTTP response, so the SDK sends
    // `error_status: null` / `error: "unknown"`.
    const event = retryFromInner({
      type: "system",
      subtype: "api_retry",
      attempt: 1,
      max_retries: 10,
      retry_delay_ms: 564,
      error_status: null,
      error: "unknown",
    })
    expect(event).not.toBeNull()
    expect(event && "status" in event).toBe(false)
    expect(event?.message).toBe("unknown")
  })

  it("defaults the counters rather than emitting NaN", () => {
    expect(retryFromInner({ type: "system", subtype: "api_retry" })).toEqual({
      type: "retry",
      phase: "scheduled",
      attempt: 0,
      maxRetries: 0,
      code: "api_retry",
    })
  })

  it("returns null for non-retry inputs", () => {
    expect(retryFromInner(null)).toBeNull()
    expect(retryFromInner({ type: "assistant" })).toBeNull()
    expect(retryFromInner({ type: "system", subtype: "init" })).toBeNull()
  })
})

// ── Execution-broker admission ─────────────────────────────────────────────
// The wrapper funnels every headless leg through the global ExecutionBroker so
// the four concurrency subsystems share one ceiling and are observable/
// cancellable as a unit.
describe("runAndCaptureAssistantReply — execution broker admission", () => {
  afterEach(() => {
    __resetExecutionBrokerForTesting()
  })

  it("registers a leg with the broker while the turn runs and releases it after", async () => {
    const broker = getExecutionBroker()
    const promise = runAndCaptureAssistantReply(
      SESSION,
      "hi",
      { provider: "openai", providerConcurrencyLimit: 2 },
      {
        timeoutMs: 1_000,
        execution: { kind: "connector", label: "WeCom reply", projectId: "p1" },
      }
    )
    await flushUntilSubscribed()
    await flushMicrotasks()
    expect(broker.countRunning()).toBe(1)
    const leg = broker.list()[0]
    expect(leg).toMatchObject({
      kind: "connector",
      label: "WeCom reply",
      projectId: "p1",
      providerId: "openai",
      providerLimit: 2,
      holdsProvider: true,
    })
    expect(broker.hasActiveSession(SESSION)).toBe(true)

    fire(assistantEvent("done"))
    fire(sessionEnded())
    await promise
    expect(broker.countRunning()).toBe(0)
  })

  it("bypasses admission when execution.skip is set", async () => {
    const broker = getExecutionBroker()
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      timeoutMs: 1_000,
      execution: { skip: true },
    })
    await flushUntilSubscribed()
    await flushMicrotasks()
    expect(broker.countRunning()).toBe(0)
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await promise
  })

  it("a broker session cancel aborts the in-flight turn", async () => {
    const broker = getExecutionBroker()
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, {
      timeoutMs: 5_000,
      execution: { kind: "goal", label: "goal turn" },
    })
    await flushUntilSubscribed()
    await flushMicrotasks()
    expect(broker.cancelBySession(SESSION)).toBe(1)
    fire(sessionEnded())
    await expect(promise).rejects.toMatchObject({ code: "aborted" })
    expect(interruptSessionMock).toHaveBeenCalledWith(SESSION)
    expect(broker.countRunning()).toBe(0)
  })

  it("defaults kind to subagent with a session-derived label", async () => {
    const broker = getExecutionBroker()
    const promise = runAndCaptureAssistantReply(SESSION, "hi", undefined, { timeoutMs: 1_000 })
    await flushUntilSubscribed()
    await flushMicrotasks()
    const leg = broker.list()[0]
    expect(leg.kind).toBe("subagent")
    expect(leg.label).toContain(SESSION.slice(0, 8))
    fire(assistantEvent("done"))
    fire(sessionEnded())
    await promise
  })
})

describe("subscribeCaptureFromEnvelopes (ADR-0090 Phase 3)", () => {
  const savedFlag = process.env.NEXT_PUBLIC_GENERIC_AGENT_HOST_COMMANDS
  const savedParityFlag = process.env.NEXT_PUBLIC_CLAUDE_SDK_PARITY_V1

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.NEXT_PUBLIC_GENERIC_AGENT_HOST_COMMANDS
    else process.env.NEXT_PUBLIC_GENERIC_AGENT_HOST_COMMANDS = savedFlag
    if (savedParityFlag === undefined) delete process.env.NEXT_PUBLIC_CLAUDE_SDK_PARITY_V1
    else process.env.NEXT_PUBLIC_CLAUDE_SDK_PARITY_V1 = savedParityFlag
    subscribeAgentEventsMock.mockReset()
  })

  it("returns null while the flag is off (legacy parse keeps running)", async () => {
    delete process.env.NEXT_PUBLIC_GENERIC_AGENT_HOST_COMMANDS
    const { subscribeCaptureFromEnvelopes } = await import("./run-and-capture")
    const result = await subscribeCaptureFromEnvelopes("s1", jest.fn())
    expect(result).toBeNull()
    expect(subscribeAgentEventsMock).not.toHaveBeenCalled()
  })

  it("maps this session's envelope events onto the capture union when enabled", async () => {
    process.env.NEXT_PUBLIC_GENERIC_AGENT_HOST_COMMANDS = "1"
    const unlisten = jest.fn()
    let subscriber: ((e: unknown) => void) | undefined
    subscribeAgentEventsMock.mockImplementation(async (cb: (e: unknown) => void) => {
      subscriber = cb
      return unlisten
    })
    const { subscribeCaptureFromEnvelopes } = await import("./run-and-capture")
    const events: unknown[] = []
    const result = await subscribeCaptureFromEnvelopes("s1", (e) => events.push(e))
    expect(result).toBe(unlisten)

    subscriber?.({ sessionId: "s1", event: { kind: "text-delta", delta: "hi" } })
    subscriber?.({ sessionId: "other", event: { kind: "text-delta", delta: "nope" } })
    subscriber?.({ sessionId: "s1", event: { kind: "lifecycle", phase: "ended" } })
    expect(events).toEqual([{ type: "text-delta", delta: "hi" }])
  })

  it("forwards canonical-only events once and excludes stale turns", async () => {
    let subscriber: ((e: unknown) => void) | undefined
    subscribeAgentEventsMock.mockImplementation(async (cb: (e: unknown) => void) => {
      subscriber = cb
      return jest.fn()
    })
    const { subscribeCaptureFromEnvelopes } = await import("./run-and-capture")
    const legacy = jest.fn()
    const canonical = jest.fn()
    await subscribeCaptureFromEnvelopes("s1", legacy, { turnId: "t1", onCanonicalEvent: canonical })
    const frame = {
      sessionId: "s1",
      turnId: "t1",
      attemptId: "a1",
      sequence: 0,
      event: { kind: "lifecycle", phase: "started" },
    }
    subscriber?.(frame)
    subscriber?.(frame)
    subscriber?.({ ...frame, turnId: "old", sequence: 1 })
    subscriber?.({
      ...frame,
      sequence: 1,
      event: { kind: "tool-summary", summary: "Read files", toolCallIds: ["c1"] },
    })
    expect(canonical.mock.calls.map(([event]) => event)).toEqual([
      frame.event,
      { kind: "tool-summary", summary: "Read files", toolCallIds: ["c1"] },
    ])
    expect(legacy).not.toHaveBeenCalled()
  })

  it("also enables the canonical stream for Claude SDK parity rollout", async () => {
    delete process.env.NEXT_PUBLIC_GENERIC_AGENT_HOST_COMMANDS
    process.env.NEXT_PUBLIC_CLAUDE_SDK_PARITY_V1 = "1"
    subscribeAgentEventsMock.mockResolvedValue(jest.fn())
    const { subscribeCaptureFromEnvelopes } = await import("./run-and-capture")

    await expect(subscribeCaptureFromEnvelopes("s1", jest.fn())).resolves.not.toBeNull()
    expect(subscribeAgentEventsMock).toHaveBeenCalledTimes(1)
  })
})

jest.mock("@/lib/ai/agent/external/runtimes/remote/remote-run-service", () => ({
  remoteDecisionId: (runId: string, requestId: string) => `${runId}:${requestId}`,
}))
const getRemoteConfigMock = jest.fn()
const startExternalTurnMock = jest.fn()
const cancelExternalTurnMock = jest.fn<Promise<boolean>, unknown[]>(async () => true)
const resolveExternalPermissionMock = jest.fn<Promise<{ resolved: boolean }>, unknown[]>(
  async () => ({ resolved: true })
)
let externalHandlers:
  | import("@/lib/ai/agent/external/runtimes/remote/remote-run-client").RemoteRunSubscription
  | undefined
const stopExternalMock = jest.fn()
jest.mock("@/lib/ai/agent/external/runtimes/remote/remote-host-configs", () => ({
  getRemoteHostConfig: (...args: unknown[]) => getRemoteConfigMock(...args),
}))
jest.mock("@/lib/ai/agent/external/runtimes/remote/remote-run-client", () => ({
  subscribeRemoteExternalRun: (
    _id: string,
    handlers: import("@/lib/ai/agent/external/runtimes/remote/remote-run-client").RemoteRunSubscription
  ) => {
    externalHandlers = handlers
    return stopExternalMock
  },
  startRemoteExternalTurn: (...args: unknown[]) => startExternalTurnMock(...args),
  cancelRemoteExternalTurn: (...args: unknown[]) => cancelExternalTurnMock(...args),
  resolveRemotePermission: (...args: unknown[]) => resolveExternalPermissionMock(...args),
}))

describe("host-owned external agent capture", () => {
  beforeEach(() => {
    externalHandlers = undefined
    getRemoteConfigMock.mockResolvedValue({
      configId: "pi-1",
      revision: "rev-1",
      lifecycleGeneration: 2,
    })
    startExternalTurnMock.mockReset()
    getRemoteConfigMock.mockClear()
    stopExternalMock.mockClear()
    cancelExternalTurnMock.mockClear()
  })

  it.each([
    [{ runtimeExtensions: [{ kind: "directory", path: "/trusted/plugin" }] }, "extensions.dynamic"],
    [{ toolPermissionRules: [{ tool: "read", decision: "deny" }] }, "tools.permission-policy"],
    [{ subagentRuntime: { contextMode: "fork" } }, "subagents.context-fork"],
    [
      { agents: { child: { contextPolicy: { compactAtTokens: 1000 } } } },
      "subagents.auto-compaction",
    ],
  ])(
    "refuses raw unsupported external options %j before admission or middleware",
    async (feature, capability) => {
      startExternalTurnMock.mockImplementation(async () => {
        externalHandlers!.onTerminal("completed", undefined)
        return { started: true }
      })
      const interceptor = jest.fn(async (request) => request)
      registerInterceptor({
        registrationId: "feature-guard",
        pluginId: "p",
        pluginInstanceId: "p#1",
        generation: 1,
        realmId: "global",
        pointId: "model.request.prepare",
        semantic: "transform",
        trustTier: "community",
        order: {},
        timeoutMs: 1_000,
        handler: interceptor as never,
        source: "interceptors",
        runtime: "frontend",
      })
      await expect(
        runAndCaptureAssistantReply(SESSION, "hello", {
          provider: "cognia:external-agent:pi-1",
          ...feature,
          execution: { capabilities: { effective: [capability] } },
        } as never)
      ).rejects.toMatchObject({ name: "AgentCapabilityError", capability })
      expect(interceptor).not.toHaveBeenCalled()
      expect(getRemoteConfigMock).not.toHaveBeenCalled()
      expect(startExternalTurnMock).not.toHaveBeenCalled()
      expect(sendPromptMock).not.toHaveBeenCalled()
    }
  )

  it("refuses malformed raw external features before starting a provider", async () => {
    startExternalTurnMock.mockImplementation(async () => {
      externalHandlers!.onTerminal("completed", undefined)
      return { started: true }
    })
    await expect(
      runAndCaptureAssistantReply(
        SESSION,
        "hello",
        {
          provider: "cognia:external-agent:pi-1",
          runtimeExtensions: null,
        } as never,
        { execution: { skip: true } }
      )
    ).rejects.toThrow("invalid_runtime_extensions")
    expect(startExternalTurnMock).not.toHaveBeenCalled()
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("dispatches Pi's provider marker to the host runner and captures its reply", async () => {
    startExternalTurnMock.mockImplementation(async () => {
      externalHandlers!.onEvent(
        { type: "message_delta", timestamp: new Date(), delta: { type: "text", text: "OK" } },
        {} as never
      )
      externalHandlers!.onTerminal("completed", undefined)
      return { started: true }
    })
    const onPartial = jest.fn()
    const result = await runAndCaptureAssistantReply(
      SESSION,
      "hello",
      {
        provider: "cognia:external-agent:pi-1",
        model: "commandcode/meta/muse-spark-1.3-contributor",
      },
      { execution: { skip: true }, onPartial, timeoutMs: 100 }
    )
    expect(result.text).toBe("OK")
    expect(startExternalTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatSessionId: SESSION,
        prompt: "hello",
        model: "commandcode/meta/muse-spark-1.3-contributor",
        stamp: { configId: "pi-1", revision: "rev-1", lifecycleGeneration: 2 },
      })
    )
    expect(sendPromptMock).not.toHaveBeenCalled()
    expect(onPartial).toHaveBeenCalledWith("OK")
    expect(stopExternalMock).toHaveBeenCalled()
  })
  it("surfaces admission refusals without falling back to the SDK", async () => {
    startExternalTurnMock.mockResolvedValue({
      started: false,
      refusal: { kind: "config", reason: "disabled" },
    })
    await expect(
      runAndCaptureAssistantReply(
        SESSION,
        "hello",
        { provider: "cognia:external-agent:pi-1" },
        { execution: { skip: true } }
      )
    ).rejects.toThrow("admission refused")
    expect(sendPromptMock).not.toHaveBeenCalled()
    expect(stopExternalMock).toHaveBeenCalled()
  })

  it("cancels an admitted run when the caller aborts", async () => {
    const controller = new AbortController()
    startExternalTurnMock.mockImplementation(async () => {
      controller.abort()
      return { started: true }
    })
    await expect(
      runAndCaptureAssistantReply(
        SESSION,
        "hello",
        { provider: "cognia:external-agent:pi-1" },
        { execution: { skip: true }, signal: controller.signal }
      )
    ).rejects.toMatchObject({ code: "aborted" })
    expect(cancelExternalTurnMock).toHaveBeenCalledTimes(1)
    expect(stopExternalMock).toHaveBeenCalled()
  })

  it("preserves the provider's failure detail", async () => {
    startExternalTurnMock.mockImplementation(async () => {
      externalHandlers!.onEvent(
        { type: "error", error: "402 Insufficient Balance", timestamp: new Date() },
        {} as never
      )
      externalHandlers!.onTerminal("failed", undefined)
      return { started: true }
    })
    await expect(
      runAndCaptureAssistantReply(
        SESSION,
        "hello",
        { provider: "cognia:external-agent:pi-1" },
        { execution: { skip: true } }
      )
    ).rejects.toThrow("402 Insufficient Balance")
  })

  it("times out and cancels a silent host run", async () => {
    startExternalTurnMock.mockResolvedValue({ started: true })
    await expect(
      runAndCaptureAssistantReply(
        SESSION,
        "hello",
        { provider: "cognia:external-agent:pi-1" },
        { execution: { skip: true }, timeoutMs: 10 }
      )
    ).rejects.toThrow("timed out")
    expect(cancelExternalTurnMock).toHaveBeenCalledTimes(1)
  })

  it("routes permission requests through the capture responder", async () => {
    startExternalTurnMock.mockImplementation(async () => {
      externalHandlers!.onEvent(
        {
          type: "permission_request",
          timestamp: new Date(),
          request: {
            id: "permission-1",
            toolCallId: "tool-1",
            toolInfo: { name: "bash", parameters: { command: "pwd" } },
          },
        } as never,
        {} as never
      )
      return { started: true }
    })
    resolveExternalPermissionMock.mockImplementation(async () => {
      externalHandlers!.onEvent(
        { type: "message_delta", timestamp: new Date(), delta: { type: "text", text: "done" } },
        {} as never
      )
      externalHandlers!.onTerminal("completed", undefined)
      return { resolved: true }
    })
    const onPermissionRequest = jest.fn(async () => ({ decision: "deny" as const }))
    const result = await runAndCaptureAssistantReply(
      SESSION,
      "hello",
      { provider: "cognia:external-agent:pi-1" },
      { execution: { skip: true }, onPermissionRequest, timeoutMs: 100 }
    )
    expect(result.text).toBe("done")
    expect(onPermissionRequest).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "bash", toolUseID: "tool-1" })
    )
    expect(resolveExternalPermissionMock).toHaveBeenCalledWith(
      expect.stringContaining("permission-1"),
      "deny"
    )
  })
  it("projects Pi tool activity, observes results, and retains billed usage", async () => {
    startExternalTurnMock.mockImplementation(async () => {
      const emit = (event: unknown) => externalHandlers!.onEvent(event as never, {} as never)
      emit({
        type: "tool_use_start",
        toolUseId: "t1",
        toolName: "bash",
        rawInput: { command: "pwd" },
      })
      emit({ type: "tool_use_end", toolUseId: "t1", input: { command: "pwd" } })
      emit({ type: "tool_result", toolUseId: "t1", result: "/project" })
      emit({ type: "message_delta", delta: { type: "text", text: "/project" } })
      emit({
        type: "message_end",
        tokenUsage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      })
      externalHandlers!.onTerminal("completed", undefined)
      return { started: true }
    })
    const onEvent = jest.fn()
    const onToolResultReview = jest.fn()
    const result = await runAndCaptureAssistantReply(
      SESSION,
      "pwd",
      { provider: "cognia:external-agent:pi-1" },
      { execution: { skip: true }, onEvent, onToolResultReview, timeoutMs: 100 }
    )
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 2 })
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tool-call", id: "t1", toolName: "bash" })
    )
    expect(onToolResultReview).toHaveBeenCalledWith({
      toolName: "bash",
      input: { command: "pwd" },
      result: "/project",
      isError: false,
    })
  })
  it("persists Pi's native session id from ordinary events and resumes it on the next turn", async () => {
    startExternalTurnMock.mockImplementation(async () => {
      externalHandlers!.onEvent(
        {
          type: "message_delta",
          timestamp: new Date(),
          sessionId: "pi-native-1",
          delta: { type: "text", text: "remembered" },
        },
        {} as never
      )
      externalHandlers!.onTerminal("completed", undefined)
      return { started: true }
    })
    const onSdkSessionId = jest.fn()
    const options = { provider: "cognia:external-agent:pi-1" }
    const cap = { execution: { skip: true }, onSdkSessionId, timeoutMs: 100 }
    const first = await runAndCaptureAssistantReply(SESSION, "remember", options, cap)
    expect(first.sdkSessionId).toBe("pi-native-1")
    expect(onSdkSessionId).toHaveBeenCalledWith("pi-native-1")
    await runAndCaptureAssistantReply(
      SESSION,
      "recall",
      { ...options, resumeSessionId: first.sdkSessionId },
      cap
    )
    expect(startExternalTurnMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ externalSessionId: "pi-native-1" })
    )
  })
})

// ── Router + Fusion action (ADR-0188 B5, D3) ─────────────────────────────
// The agent surface's real entry point: `runAndCaptureAssistantReply` itself,
// with only the dynamic host import stubbed, so a chosen mode is proven to
// reach a fusion run and an unset one is proven to reach the sidecar.
describe("Router + Fusion action", () => {
  const ON = {
    routerFusion: { enabled: true, surfaces: { agentsWorkflows: true } },
  } as unknown as AppSettings
  const OFF = {
    routerFusion: { enabled: true, surfaces: { agentsWorkflows: false } },
  } as unknown as AppSettings
  const answer = {
    kind: "answered" as const,
    runId: "run-fusion-1",
    mode: "cascade" as const,
    text: "the checked answer",
    qualityStatus: "accepted" as const,
    usage: { promptTokens: 30, completionTokens: 7, totalTokens: 37 },
    spentMicrousd: 4500,
    modelCalls: 2,
    warnings: [],
  }

  afterEach(() => {
    __resetFusionScopesForTesting()
  })

  it("runs the turn as a fusion run and never sends a prompt to the sidecar", async () => {
    const calls: Array<Record<string, unknown>> = []
    const result = await runAndCaptureAssistantReply(SESSION, "compare the tariffs", undefined, {
      execution: { skip: true },
      fusion: {
        action: "cascade",
        settings: ON,
        featureId: "teammate:tm1",
        workspaceId: "project-1",
        loadHost: async () =>
          ({
            runAgentsWorkflowsFusion: async (input: Record<string, unknown>) => {
              calls.push(input)
              return answer
            },
          }) as never,
      },
    })
    expect(result.text).toBe("the checked answer")
    expect(result.messageId).toBe("run-fusion-1")
    expect(result.usage).toMatchObject({ inputTokens: 30, outputTokens: 7 })
    expect(sendPromptMock).not.toHaveBeenCalled()
    expect(calls[0]).toMatchObject({
      mode: "cascade",
      origin: "agent",
      featureId: "teammate:tm1",
      workspaceId: "project-1",
      hasFusionAncestor: false,
    })
  })

  it("carries the turn's system prompt into the run's messages", async () => {
    const calls: Array<{ messages?: unknown }> = []
    await runAndCaptureAssistantReply(
      SESSION,
      "compare the tariffs",
      { systemPrompt: "Be terse.", appendSystemPrompt: "Cite sources." },
      {
        execution: { skip: true },
        fusion: {
          action: "panel",
          settings: ON,
          loadHost: async () =>
            ({
              runAgentsWorkflowsFusion: async (input: { messages?: unknown }) => {
                calls.push(input)
                return answer
              },
            }) as never,
        },
      }
    )
    expect(calls[0]?.messages).toEqual([
      { role: "system", content: "Be terse.\n\nCite sources." },
      { role: "user", content: "compare the tariffs" },
    ])
  })

  it("[ACC:OFF-AGENTS] runs the ordinary sidecar turn when the surface is off", async () => {
    const loadHost = jest.fn()
    const promise = runAndCaptureAssistantReply(SESSION, "hello", undefined, {
      execution: { skip: true },
      timeoutMs: 200,
      fusion: { action: "cascade", settings: OFF, loadHost: loadHost as never },
    })
    await flushUntilSubscribed()
    await flushMicrotasks()
    fire(assistantEvent("plain reply"))
    fire(sessionEnded())
    await expect(promise).resolves.toMatchObject({ text: "plain reply" })
    expect(loadHost).not.toHaveBeenCalled()
    expect(sendPromptMock).toHaveBeenCalled()
  })

  it("[ACC:OFF-AGENTS] an unset action never reads settings or loads the engine", async () => {
    const promise = runAndCaptureAssistantReply(SESSION, "hello", undefined, {
      execution: { skip: true },
      timeoutMs: 200,
    })
    await flushUntilSubscribed()
    await flushMicrotasks()
    fire(assistantEvent("plain reply"))
    fire(sessionEnded())
    await expect(promise).resolves.toMatchObject({ text: "plain reply" })
  })

  it("fails explicitly when the chosen mode is refused", async () => {
    await expect(
      runAndCaptureAssistantReply(SESSION, "compare", undefined, {
        execution: { skip: true },
        fusion: {
          action: "panel",
          settings: ON,
          loadHost: async () =>
            ({
              runAgentsWorkflowsFusion: async () => ({
                kind: "refused",
                code: "ROUTE_NO_SOLUTION",
                reasons: ["panel_review:FUSION_RECURSION"],
              }),
            }) as never,
        },
      })
    ).rejects.toMatchObject({ code: "ROUTE_NO_SOLUTION" })
    expect(sendPromptMock).not.toHaveBeenCalled()
  })
})
