/**
 * Co-located unit test for `runAndCaptureAssistantReply`. Mocks the Tauri
 * IPC layer so we can drive synthetic event sequences and assert the
 * wrapper resolves / rejects correctly. The wrapper itself is pure — no
 * timers other than its watchdog, which we keep on (with a low
 * `timeoutMs` per case) to also exercise the timeout path.
 */

import { runAndCaptureAssistantReply, RunAndCaptureError } from "./run-and-capture"
import type { ClaudeEvent } from "./types"

// ── Mock the IPC layer the wrapper depends on ─────────────────────────────
// `onClaudeMessage` returns the unlistener; we capture the handler so the
// test can dispatch synthetic events.

let captured: ((evt: ClaudeEvent) => void) | null = null
const sendPromptMock = jest.fn<Promise<void>, [string, unknown, unknown?]>(async () => undefined)
const interruptSessionMock = jest.fn<Promise<void>, [string]>(async () => undefined)
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
}))

beforeEach(() => {
  captured = null
  sendPromptMock.mockClear()
  interruptSessionMock.mockClear()
  unlistenMock.mockClear()
  onClaudeMessageMock.mockClear()
})

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
})
