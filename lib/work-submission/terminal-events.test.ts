/** @jest-environment jsdom */

import type { ClaudeEvent } from "@cognia/agent-config-types"

import {
  registerInteractiveWorkSubmissionEvents,
  startWorkSubmissionTerminalEvents,
} from "./terminal-events"
import type { Unsubscribe } from "./outbox-runner"

async function flushEvents(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) await Promise.resolve()
}

describe("work submission terminal events", () => {
  it("settles terminal sessions when no chat route owns the event pipeline", async () => {
    let handler: ((event: ClaudeEvent) => void) | undefined
    const settleSession = jest.fn(async () => true)
    const stop = startWorkSubmissionTerminalEvents({
      subscribe: async (next) => {
        handler = next
        return () => {}
      },
      settleSession,
    })
    await Promise.resolve()

    handler?.({ type: "session_ended", sessionId: "session-1", error: "boom" })
    await flushEvents()

    expect(settleSession).toHaveBeenCalledWith("session-1", {
      outcome: "failed",
      errorCode: "turn_error",
    })
    stop()
  })

  it("commits recovered output through the exactly-once settlement transaction", async () => {
    let handler: ((event: ClaudeEvent) => void) | undefined
    const initial = [{ id: "user-1", role: "user", parts: [] }] as never
    const projected = [
      ...initial,
      { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "done" }] },
    ] as never
    const persistMessages = jest.fn(async () => {})
    const settleSession = jest.fn(
      async (_sessionId: string, input: { writeTranscript?: () => Promise<void> }) => {
        await input.writeTranscript?.()
        return true
      }
    )
    const onReady = jest.fn()
    const stop = startWorkSubmissionTerminalEvents({
      subscribe: async (next) => {
        handler = next
        return () => {}
      },
      loadMessages: async () => initial,
      applyEvent: () => ({ messages: projected }),
      persistMessages,
      settleSession,
      hasOpenSubmission: async () => true,
      onReady,
    })
    await Promise.resolve()
    expect(onReady).toHaveBeenCalledTimes(1)

    handler?.({
      type: "event",
      sessionId: "session-1",
      event: { type: "assistant" } as never,
    })
    handler?.({ type: "session_ended", sessionId: "session-1" })
    for (let attempt = 0; attempt < 10 && settleSession.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve()
    }

    expect(persistMessages).toHaveBeenCalledWith("session-1", projected)
    expect(settleSession).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ outcome: "completed", writeTranscript: expect.any(Function) })
    )
    stop()
  })

  it("ignores SDK frames from sessions with no open work submission", async () => {
    let handler: ((event: ClaudeEvent) => void) | undefined
    const loadMessages = jest.fn(async () => [])
    const applyEvent = jest.fn(() => ({ messages: [] }))
    const stop = startWorkSubmissionTerminalEvents({
      subscribe: async (next) => {
        handler = next
        return () => {}
      },
      hasOpenSubmission: async () => false,
      loadMessages,
      applyEvent,
    })
    await Promise.resolve()

    handler?.({ type: "event", sessionId: "scheduler-1", event: { type: "assistant" } as never })
    await flushEvents()

    expect(loadMessages).not.toHaveBeenCalled()
    expect(applyEvent).not.toHaveBeenCalled()
    stop()
  })

  it("defers to the interactive pipeline so routing fallback can decide settlement", async () => {
    let handler: ((event: ClaudeEvent) => void) | undefined
    const settleSession = jest.fn(async () => true)
    const unregister = registerInteractiveWorkSubmissionEvents()
    const stop = startWorkSubmissionTerminalEvents({
      subscribe: async (next) => {
        handler = next
        return () => {}
      },
      settleSession,
    })
    await Promise.resolve()

    handler?.({ type: "session_ended", sessionId: "session-1" })
    await Promise.resolve()
    expect(settleSession).not.toHaveBeenCalled()

    unregister()
    handler?.({ type: "session_ended", sessionId: "session-1" })
    await flushEvents()
    expect(settleSession).toHaveBeenCalledWith("session-1", { outcome: "completed" })
    stop()
  })

  it("fails every dispatched row when the sidecar exits without an interactive owner", async () => {
    let handler: ((event: ClaudeEvent) => void) | undefined
    const settleSubmission = jest.fn(async () => true)
    const stop = startWorkSubmissionTerminalEvents({
      subscribe: async (next) => {
        handler = next
        return () => {}
      },
      listDispatched: async () =>
        [
          { id: "submission-1", sessionId: "session-1" },
          { id: "submission-2", sessionId: "session-2" },
        ] as never,
      loadMessages: async () => [],
      settleSubmission,
    })
    await Promise.resolve()

    handler?.({ type: "sidecar_exited" })
    for (let attempt = 0; attempt < 20 && settleSubmission.mock.calls.length < 2; attempt += 1) {
      await Promise.resolve()
    }

    expect(settleSubmission).toHaveBeenCalledTimes(2)
    expect(settleSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        submissionId: "submission-1",
        outcome: "failed",
        errorCode: "sidecar_exit",
        writeTranscript: expect.any(Function),
      })
    )
    stop()
  })

  it("unsubscribes a listener that resolves after teardown", async () => {
    let resolveSubscribe: ((stop: Unsubscribe) => void) | undefined
    const transportStop = jest.fn()
    const stop = startWorkSubmissionTerminalEvents({
      subscribe: () =>
        new Promise((resolve) => {
          resolveSubscribe = resolve
        }),
    })

    stop()
    resolveSubscribe?.(transportStop)
    await Promise.resolve()

    expect(transportStop).toHaveBeenCalledTimes(1)
  })

  it("does not announce readiness after teardown wins the subscribe race", async () => {
    let resolveSubscribe: ((stop: Unsubscribe) => void) | undefined
    const onReady = jest.fn()
    const stop = startWorkSubmissionTerminalEvents({
      subscribe: () =>
        new Promise((resolve) => {
          resolveSubscribe = resolve
        }),
      onReady,
    })

    stop()
    resolveSubscribe?.(() => {})
    await Promise.resolve()

    expect(onReady).not.toHaveBeenCalled()
  })

  it("reports and retries a failed transport subscription", async () => {
    jest.useFakeTimers()
    const onError = jest.fn()
    const onReady = jest.fn()
    const subscribe = jest
      .fn()
      .mockRejectedValueOnce(new Error("transport unavailable"))
      .mockResolvedValueOnce(() => {})
    const stop = startWorkSubmissionTerminalEvents({ subscribe, onError, onReady, retryMs: 10 })

    await flushEvents()
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
    expect(onReady).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(10)
    expect(subscribe).toHaveBeenCalledTimes(2)
    expect(onReady).toHaveBeenCalledTimes(1)

    stop()
    jest.useRealTimers()
  })
})
