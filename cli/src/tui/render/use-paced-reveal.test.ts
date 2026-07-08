/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

import { snapForward, usePacedReveal } from "./use-paced-reveal"

describe("snapForward", () => {
  it("stops just after the next boundary within the lookahead", () => {
    // "hello world" — from index 2, the next boundary is the space at index 5.
    expect(snapForward("hello world", 2)).toBe(6)
  })

  it("clamps at the end of the text", () => {
    expect(snapForward("hi", 5)).toBe(2)
  })

  it("returns n unchanged when no boundary is within the lookahead window", () => {
    // A long unbroken token reveals atomically rather than mid-token.
    expect(snapForward("abcdefghijklmnop", 0, 8)).toBe(0)
  })

  it("snaps on punctuation as well as whitespace", () => {
    expect(snapForward("end. next", 0)).toBe(4)
  })
})

describe("usePacedReveal", () => {
  it("returns the whole target immediately when disabled", () => {
    const { result } = renderHook(() => usePacedReveal("full text", false))
    expect(result.current).toBe("full text")
  })

  it("reveals progressively while enabled, then catches up", () => {
    jest.useFakeTimers()
    try {
      const target = "one two three four five"
      const { result } = renderHook(() => usePacedReveal(target, true, 24))
      // Starts empty.
      expect(result.current).toBe("")
      // Advance several ticks; the revealed text is always a growing prefix.
      let prevLen = 0
      for (let i = 0; i < 30; i++) {
        act(() => {
          jest.advanceTimersByTime(24)
        })
        expect(target.startsWith(result.current)).toBe(true)
        expect(result.current.length).toBeGreaterThanOrEqual(prevLen)
        prevLen = result.current.length
      }
      // Eventually fully revealed.
      expect(result.current).toBe(target)
    } finally {
      jest.useRealTimers()
    }
  })
})
