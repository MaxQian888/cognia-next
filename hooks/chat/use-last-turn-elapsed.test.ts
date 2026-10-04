/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"
import type { UIMessage } from "ai"

import { useLastTurnElapsedMs } from "./use-last-turn-elapsed"
import { IDLE_TIMING } from "@/lib/claude/run-status"
import { makeSessionSlice, useChatStore, type SessionChatSlice } from "@/stores/chat"

const SID = "s1"

function seed(slice: Partial<SessionChatSlice>) {
  useChatStore.setState({
    activeSessionId: SID,
    sessions: { [SID]: { ...makeSessionSlice(), ...slice } },
  })
}

function patch(slice: Partial<SessionChatSlice>) {
  useChatStore.setState((state) => ({
    sessions: { ...state.sessions, [SID]: { ...state.sessions[SID]!, ...slice } },
  }))
}

const sealed: UIMessage[] = [
  { id: "u", role: "user", parts: [] },
  { id: "a", role: "assistant", parts: [], metadata: { usage: { durationMs: 90_000 } } },
] as unknown as UIMessage[]

let nowSpy: jest.SpyInstance<number, []>

beforeEach(() => {
  useChatStore.setState({ activeSessionId: null, sessions: {} })
  nowSpy = jest.spyOn(Date, "now").mockReturnValue(100_000)
})

afterEach(() => nowSpy.mockRestore())

describe("useLastTurnElapsedMs", () => {
  it("reads the transcript when this mount never watched the turn run", () => {
    seed({ status: "idle", runId: 0, messages: sealed })
    const { result } = renderHook(() =>
      useLastTurnElapsedMs({ sessionId: SID, runId: 0, messages: sealed })
    )
    expect(result.current).toBe(90_000)
  })

  it("is null when neither source knows", () => {
    const bare = [{ id: "a", role: "assistant", parts: [] }] as unknown as UIMessage[]
    const { result } = renderHook(() =>
      useLastTurnElapsedMs({ sessionId: SID, runId: 0, messages: bare })
    )
    expect(result.current).toBeNull()
  })

  it("banks the active clock at settle, excluding the open approval wait", () => {
    seed({
      status: "awaiting_approval",
      runId: 3,
      runTiming: { startedAt: 40_000, pausedAt: 70_000, pausedAccumMs: 0 },
    })
    const { result, rerender } = renderHook(
      ({ runId }) => useLastTurnElapsedMs({ sessionId: SID, runId, messages: sealed }),
      { initialProps: { runId: 3 } }
    )
    act(() => patch({ status: "idle", runTiming: IDLE_TIMING }))
    // 100s − 40s, minus the 30s still paused on approval when it ended.
    expect(result.current).toBe(30_000)

    // The next turn mints a new run id: the banked figure no longer describes
    // the turn on screen, so the transcript answers again.
    rerender({ runId: 4 })
    expect(result.current).toBe(90_000)
  })

  it("does not bank anything while the clock is still running", () => {
    seed({
      status: "streaming",
      runId: 1,
      runTiming: { startedAt: 10_000, pausedAt: null, pausedAccumMs: 0 },
    })
    const { result } = renderHook(() =>
      useLastTurnElapsedMs({ sessionId: SID, runId: 1, messages: sealed })
    )
    act(() =>
      patch({
        status: "awaiting_approval",
        runTiming: { startedAt: 10_000, pausedAt: 50_000, pausedAccumMs: 0 },
      })
    )
    expect(result.current).toBe(90_000)
  })

  it("ignores a settle in another session", () => {
    seed({ status: "idle", runId: 2 })
    useChatStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        other: {
          ...makeSessionSlice(),
          status: "streaming",
          runId: 2,
          runTiming: { startedAt: 1_000, pausedAt: null, pausedAccumMs: 0 },
        },
      },
    }))
    const { result } = renderHook(() =>
      useLastTurnElapsedMs({ sessionId: SID, runId: 2, messages: sealed })
    )
    act(() =>
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          other: { ...state.sessions.other!, status: "idle", runTiming: IDLE_TIMING },
        },
      }))
    )
    expect(result.current).toBe(90_000)
  })
})
