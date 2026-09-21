import { act, render, screen } from "@testing-library/react"
import { ComposerHintCarousel } from "./composer-hint-carousel"

jest.mock("motion/react", () => {
  const actual = jest.requireActual<typeof import("motion/react")>("motion/react")
  return { ...actual, useReducedMotion: jest.fn(() => false) }
})

import { useReducedMotion } from "motion/react"
const mockUseReducedMotion = useReducedMotion as jest.Mock

const HINTS = ["one", "two", "three"]

function text() {
  return screen.getByTestId("composer-hint-carousel").textContent ?? ""
}

// Each setState lands after act() flushes the render + effect, so the next
// phase timeout is only scheduled once the previous act() window closed —
// one pending timer fires per advanceTimersToNextTimer call. `steps(n)`
// therefore advances exactly n state-machine ticks.
function steps(n = 1) {
  for (let i = 0; i < n; i++) {
    act(() => {
      jest.advanceTimersToNextTimer()
    })
  }
}

// Steps per full type→hold→delete→gap cycle for a hint of `len` chars:
// (len+1) typing ticks + 1 hold + (len+1) deleting ticks + 1 gap.
function cycleSteps(len: number) {
  return 2 * len + 4
}

describe("ComposerHintCarousel", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    mockUseReducedMotion.mockReturnValue(false)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("starts empty and keeps the layer inert for focus", () => {
    render(<ComposerHintCarousel hints={HINTS} />)
    const el = screen.getByTestId("composer-hint-carousel")
    expect(el).toHaveAttribute("aria-hidden", "true")
    expect(el.className).toContain("pointer-events-none")
    expect(text()).toBe("")
  })

  it("types the hint character by character", () => {
    render(<ComposerHintCarousel hints={HINTS} />)
    steps(2)
    expect(text()).toBe("on")
    steps(1)
    expect(text()).toBe("one")
  })

  it("holds the full hint, deletes it, then types the next one", () => {
    render(<ComposerHintCarousel hints={HINTS} />)
    steps(4) // type "one" + flip to hold
    expect(text()).toBe("one")
    steps(1) // hold fires → deleting
    expect(text()).toBe("one")
    steps(4) // delete 3 chars + flip to gap
    expect(text()).toBe("")
    steps(1) // gap fires → next hint, typing
    expect(text()).toBe("")
    steps(2)
    expect(text()).toBe("tw")
    steps(2) // finish "two" + flip to hold
    expect(text()).toBe("two")
  })

  it("wraps around to the first hint after the last", () => {
    render(<ComposerHintCarousel hints={HINTS} />)
    for (const hint of HINTS) steps(cycleSteps(hint.length))
    steps(3)
    expect(text()).toBe("one")
  })

  it("reports the full active hint so Tab can accept it mid-typing", () => {
    const onActiveHint = jest.fn()
    render(<ComposerHintCarousel hints={HINTS} onActiveHint={onActiveHint} />)
    // Whole hint reported immediately — not the chars typed so far.
    expect(onActiveHint).toHaveBeenLastCalledWith("one")
    steps(3) // still mid-typing "one"
    expect(onActiveHint).toHaveBeenLastCalledWith("one")
    steps(cycleSteps("one".length) - 3) // finish the cycle → next hint active
    expect(onActiveHint).toHaveBeenLastCalledWith("two")
  })

  it("renders nothing but the caret layer when hints are empty", () => {
    render(<ComposerHintCarousel hints={[]} />)
    act(() => {
      jest.advanceTimersByTime(10_000)
    })
    expect(text()).toBe("")
  })

  it("pops hints whole instead of ticking when reduced motion is set", () => {
    mockUseReducedMotion.mockReturnValue(true)
    render(<ComposerHintCarousel hints={HINTS} />)
    steps(1) // "one" pops in fully
    expect(text()).toBe("one")
    steps(5) // hold → deleting → instant clear → gap → next typing
    steps(1) // "two" pops in fully
    expect(text()).toBe("two")
  })
})
