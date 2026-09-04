/** @jest-environment jsdom */
import React from "react"
import { act, render, within } from "@testing-library/react"

import { Spinner, ThinkingPulse, SPINNER_FRAMES, PULSE_FRAMES, frameAt } from "./Spinner"
import { animationClock } from "../render/animation-clock"
import { ThemeProvider } from "../theme/context"
import { BUILTIN_THEMES } from "../theme/builtins"

const withTheme = (node: React.ReactNode) =>
  render(<ThemeProvider palette={BUILTIN_THEMES.cognia}>{node}</ThemeProvider>)

describe("frameAt", () => {
  it("cycles, including past the end of the list", () => {
    expect(frameAt(SPINNER_FRAMES, 0)).toBe("⠋")
    expect(frameAt(SPINNER_FRAMES, SPINNER_FRAMES.length)).toBe("⠋")
    expect(frameAt(SPINNER_FRAMES, SPINNER_FRAMES.length + 2)).toBe(SPINNER_FRAMES[2])
  })

  it("never indexes out of the list for a negative tick", () => {
    expect(SPINNER_FRAMES).toContain(frameAt(SPINNER_FRAMES, -1))
  })
})

describe("Spinner", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    animationClock.stopAll()
    jest.useRealTimers()
  })

  it("animates through its frames", () => {
    const view = withTheme(<Spinner />)
    expect(view.container.textContent).toBe(SPINNER_FRAMES[0])
    act(() => void jest.advanceTimersByTime(80))
    expect(view.container.textContent).toBe(SPINNER_FRAMES[1])
  })

  it("draws every spinner on screen on the same frame", () => {
    // Independent per-instance timers made a column of running tool cards chase
    // each other, which is what the shared clock removes.
    const view = withTheme(
      <>
        <span data-testid="a">
          <Spinner />
        </span>
        <span data-testid="b">
          <Spinner />
        </span>
      </>
    )
    act(() => void jest.advanceTimersByTime(240))
    const scope = within(view.container)
    expect(scope.getByTestId("a").textContent).toBe(scope.getByTestId("b").textContent)
    expect(animationClock.timerCount).toBe(1)
  })

  it("runs no timer once every spinner is gone", () => {
    const view = withTheme(<Spinner />)
    expect(animationClock.timerCount).toBe(1)
    view.unmount()
    expect(animationClock.timerCount).toBe(0)
  })
})

describe("ThinkingPulse", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    animationClock.stopAll()
    jest.useRealTimers()
  })

  it("breathes on its own, slower cadence", () => {
    const view = withTheme(<ThinkingPulse />)
    expect(view.container.textContent).toBe(PULSE_FRAMES[0])
    // Faster than the pulse but slower than the spinner: the pulse must not have
    // moved yet, or it is animating on the wrong clock.
    act(() => void jest.advanceTimersByTime(80))
    expect(view.container.textContent).toBe(PULSE_FRAMES[0])
    act(() => void jest.advanceTimersByTime(240))
    expect(view.container.textContent).toBe(PULSE_FRAMES[1])
  })
})
