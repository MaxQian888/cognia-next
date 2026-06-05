import { renderHook } from "@testing-library/react"
import { ACTIVITY_POST_THROTTLE_MS, useActivityTracker } from "./use-activity-tracker"
import {
  __resetActivitySignalForTesting,
  getLastActivityAtMs,
} from "@/lib/pet/llm/proactive/activity-signal"
import type { BroadcastChannelLike } from "@/lib/pet/events/cross-window-bridge"

function makeChannel(): BroadcastChannelLike & { posted: unknown[] } {
  const posted: unknown[] = []
  return {
    posted,
    postMessage: (m: unknown) => posted.push(m),
    close: jest.fn(),
    onmessage: null,
  }
}

let nowMs = 1_000_000

afterEach(() => {
  __resetActivitySignalForTesting()
})

describe("useActivityTracker", () => {
  it("marks activity on every input event but throttles bridge posts", () => {
    const channel = makeChannel()
    renderHook(() => useActivityTracker(true, { channel, now: () => nowMs }))

    window.dispatchEvent(new Event("pointermove"))
    expect(getLastActivityAtMs()).toBe(nowMs)
    expect(channel.posted).toHaveLength(1)
    expect(channel.posted[0]).toEqual({ v: 1, t: "activity", at: nowMs })

    // Rapid follow-ups inside the throttle window: signal updates, no post.
    nowMs += 1000
    window.dispatchEvent(new Event("keydown"))
    nowMs += 1000
    window.dispatchEvent(new Event("pointerdown"))
    expect(getLastActivityAtMs()).toBe(nowMs)
    expect(channel.posted).toHaveLength(1)

    // Past the window → one more post.
    nowMs += ACTIVITY_POST_THROTTLE_MS
    window.dispatchEvent(new Event("pointermove"))
    expect(channel.posted).toHaveLength(2)
  })

  it("works without a channel (web mode: signal only)", () => {
    renderHook(() => useActivityTracker(true, { channel: null, now: () => nowMs }))
    window.dispatchEvent(new Event("focus"))
    expect(getLastActivityAtMs()).toBe(nowMs)
  })

  it("does nothing when disabled and removes listeners on unmount", () => {
    const channel = makeChannel()
    const { unmount } = renderHook(() => useActivityTracker(false, { channel, now: () => nowMs }))
    window.dispatchEvent(new Event("pointermove"))
    expect(getLastActivityAtMs()).toBeNull()
    expect(channel.posted).toHaveLength(0)
    unmount()

    const { unmount: unmount2 } = renderHook(() =>
      useActivityTracker(true, { channel, now: () => nowMs })
    )
    unmount2()
    window.dispatchEvent(new Event("pointermove"))
    expect(getLastActivityAtMs()).toBeNull()
  })
})
