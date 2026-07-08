/**
 * @jest-environment jsdom
 */

interface SliceLike {
  status?: string
  steerQueue: Array<{ id: string; text: string; blocks?: unknown[] }>
}

const state = {
  activeSessionId: null as string | null,
  status: "idle",
  sessions: {} as Record<string, SliceLike>,
  openSessionIds: [] as string[],
  clearSteerQueue: jest.fn((id: string) => {
    if (state.sessions[id]) state.sessions[id].steerQueue = []
  }),
}

jest.mock("@/stores/chat", () => ({
  useChatStore: { getState: () => state },
}))

import { isSessionOpen, maybeDrainSteer, sessionStatusOf, steerArmed } from "./steer-runtime"

beforeEach(() => {
  state.activeSessionId = null
  state.status = "idle"
  state.sessions = {}
  state.openSessionIds = []
  state.clearSteerQueue.mockClear()
  steerArmed.clear()
})

describe("sessionStatusOf", () => {
  it("prefers the session's own slice status", () => {
    state.sessions["s1"] = { status: "streaming", steerQueue: [] }
    expect(sessionStatusOf("s1")).toBe("streaming")
  })

  it("falls back to the active mirror for the focused session", () => {
    state.activeSessionId = "s1"
    state.status = "awaiting_approval"
    expect(sessionStatusOf("s1")).toBe("awaiting_approval")
  })

  it("reports idle for unknown background sessions", () => {
    expect(sessionStatusOf("ghost")).toBe("idle")
  })
})

describe("isSessionOpen", () => {
  it("is true only for sessions with a visible pane", () => {
    state.openSessionIds = ["s1"]
    expect(isSessionOpen("s1")).toBe(true)
    expect(isSessionOpen("s2")).toBe(false)
  })
})

describe("maybeDrainSteer", () => {
  it("no-ops on an empty queue but always disarms", () => {
    steerArmed.add("s1")
    const replay = jest.fn()
    maybeDrainSteer("s1", replay)
    expect(replay).not.toHaveBeenCalled()
    expect(steerArmed.has("s1")).toBe(false)
    expect(state.clearSteerQueue).not.toHaveBeenCalled()
  })

  it("clears the queue and replays one framed payload", () => {
    state.sessions["s1"] = {
      steerQueue: [
        { id: "a", text: "first" },
        { id: "b", text: "second" },
      ],
    }
    const replay = jest.fn()
    maybeDrainSteer("s1", replay)
    expect(state.clearSteerQueue).toHaveBeenCalledWith("s1")
    expect(replay).toHaveBeenCalledTimes(1)
    const payload = replay.mock.calls[0][0]
    const text = typeof payload === "string" ? payload : JSON.stringify(payload)
    expect(text).toContain("first")
    expect(text).toContain("second")
  })
})
