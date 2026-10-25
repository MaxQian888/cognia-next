/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

import type { TranscriptLiveFrame } from "@/lib/chat/transcript/live-frames"

import { SETTLED_LIVE_REPLY_MAX_MS, useTranscriptLiveTurn } from "./use-transcript-live-turn"

function source() {
  const listeners = new Map<string, (frame: TranscriptLiveFrame) => void>()
  const unsubscribed: string[] = []
  return {
    listeners,
    unsubscribed,
    subscribeLive: jest.fn((sessionId: string, listener: (frame: TranscriptLiveFrame) => void) => {
      listeners.set(sessionId, listener)
      return () => {
        unsubscribed.push(sessionId)
        listeners.delete(sessionId)
      }
    }),
  }
}

const frame = (overrides: Partial<TranscriptLiveFrame> = {}): TranscriptLiveFrame => ({
  sessionId: "s1",
  messageId: "assistant-a1",
  replyTo: "u1",
  seq: 1,
  base: 0,
  keyframe: true,
  state: "streaming",
  parts: [{ type: "text", text: "hi" }],
  ...overrides,
})

describe("useTranscriptLiveTurn", () => {
  it("p6e folds the session's frames into the reply it draws", () => {
    const live = source()
    const { result } = renderHook(() => useTranscriptLiveTurn("s1", live, 3))
    expect(result.current).toBeNull()
    act(() => live.listeners.get("s1")?.(frame()))
    act(() =>
      live.listeners.get("s1")?.(
        frame({ seq: 2, base: 1, keyframe: false, parts: [{ type: "text", text: " there" }] })
      )
    )
    expect(result.current?.parts).toEqual([
      { type: "text", text: "hi" },
      { type: "text", text: " there" },
    ])
  })

  it("p6e lets go of a settled reply when the timeline reads past it", () => {
    const live = source()
    const { result, rerender } = renderHook(
      ({ revision }) => useTranscriptLiveTurn("s1", live, revision),
      { initialProps: { revision: 4 as number | null } }
    )
    act(() => live.listeners.get("s1")?.(frame({ state: "settled", afterRevision: 5 })))
    expect(result.current?.state).toBe("settled")
    // The read of an earlier write lands after the final frame: keep drawing.
    rerender({ revision: 5 })
    expect(result.current?.state).toBe("settled")
    rerender({ revision: 6 })
    expect(result.current).toBeNull()
  })

  it("p6e lets go of a settled reply the timeline never catches up with", () => {
    jest.useFakeTimers()
    try {
      const live = source()
      const { result } = renderHook(() => useTranscriptLiveTurn("s1", live, null))
      act(() => live.listeners.get("s1")?.(frame({ state: "settled" })))
      expect(result.current?.state).toBe("settled")
      act(() => jest.advanceTimersByTime(SETTLED_LIVE_REPLY_MAX_MS))
      expect(result.current).toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })

  it("p6e follows a switch of conversation and never shows the previous one's reply", () => {
    const live = source()
    const { result, rerender } = renderHook(
      ({ sessionId }) => useTranscriptLiveTurn(sessionId, live, 1),
      { initialProps: { sessionId: "s1" } }
    )
    act(() => live.listeners.get("s1")?.(frame()))
    expect(result.current?.sessionId).toBe("s1")
    rerender({ sessionId: "s2" })
    expect(result.current).toBeNull()
    expect(live.unsubscribed).toEqual(["s1"])
    expect(live.subscribeLive).toHaveBeenLastCalledWith("s2", expect.any(Function))
  })
})
