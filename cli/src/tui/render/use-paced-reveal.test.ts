/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

import { shouldResetReveal, snapForward, usePacedReveal } from "./use-paced-reveal"

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

describe("shouldResetReveal", () => {
  it("continues while the stream only appends", () => {
    expect(shouldResetReveal("Hello", "Hello world")).toBe(false)
    expect(shouldResetReveal("", "Hello")).toBe(false)
  })

  it("restarts when the next text is shorter — a new, briefer turn", () => {
    expect(shouldResetReveal("A long first answer", "Ok")).toBe(true)
  })

  it("restarts when the text was rewritten in place rather than extended", () => {
    expect(shouldResetReveal("Hello", "Goodbye there")).toBe(true)
  })

  it("continues on an identical target (an idle re-render)", () => {
    expect(shouldResetReveal("Hello", "Hello")).toBe(false)
  })
})

describe("usePacedReveal — turn identity", () => {
  /** Run the reveal to completion for the current target. */
  const settle = () => {
    for (let i = 0; i < 60; i++) act(() => void jest.advanceTimersByTime(24))
  }

  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it("restarts a SHORT next turn instead of showing it whole", () => {
    const long = "a fairly long first answer that streams for a while"
    const { result, rerender } = renderHook(
      ({ text, epoch }: { text: string; epoch: number }) => usePacedReveal(text, true, { epoch }),
      { initialProps: { text: long, epoch: 1 } }
    )
    settle()
    expect(result.current).toBe(long)

    // The old hook kept only a character count, so this short second turn
    // appeared complete on its first frame.
    rerender({ text: "Ok.", epoch: 2 })
    expect(result.current).toBe("")
    settle()
    expect(result.current).toBe("Ok.")
  })

  it("keeps revealing across appends within one turn", () => {
    const { result, rerender } = renderHook(
      ({ text }: { text: string }) => usePacedReveal(text, true, { epoch: 1 }),
      { initialProps: { text: "hello " } }
    )
    settle()
    expect(result.current).toBe("hello ")
    rerender({ text: "hello world" })
    // An append continues rather than restarting — no flicker back to empty.
    expect(result.current).toBe("hello ")
    settle()
    expect(result.current).toBe("hello world")
  })

  it("restarts when the stream was rewritten in place, without an epoch change", () => {
    const { result, rerender } = renderHook(
      ({ text }: { text: string }) => usePacedReveal(text, true, { epoch: 1 }),
      { initialProps: { text: "first answer" } }
    )
    settle()
    rerender({ text: "different answer entirely" })
    expect(result.current).toBe("")
    settle()
    expect(result.current).toBe("different answer entirely")
  })

  it("shows an aborted turn's remaining text rather than freezing mid-reveal", () => {
    const { result, rerender } = renderHook(
      ({ text, enabled }: { text: string; enabled: boolean }) =>
        usePacedReveal(text, enabled, { epoch: 1 }),
      { initialProps: { text: "partial answer", enabled: true } }
    )
    act(() => void jest.advanceTimersByTime(24))
    // The turn aborts and the surface stops pacing: the whole text is shown.
    rerender({ text: "partial answer", enabled: false })
    expect(result.current).toBe("partial answer")
  })

  it("accepts the legacy numeric paceMs argument", () => {
    const { result } = renderHook(() => usePacedReveal("text", false, 50))
    expect(result.current).toBe("text")
  })
})
