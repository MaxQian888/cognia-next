/** @jest-environment jsdom */
import React from "react"
import { act, render, within, type RenderResult } from "@testing-library/react"

import { animationClock } from "./animation-clock"
import { useAnimationTick } from "./use-animation-tick"

function Probe({ active, interval = 80 }: { active: boolean; interval?: number }) {
  const tick = useAnimationTick(interval, active)
  return <span data-testid="tick">{tick}</span>
}

describe("useAnimationTick", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    animationClock.stopAll()
    jest.useRealTimers()
  })

  it("advances with the shared clock", () => {
    const { getByTestId } = render(<Probe active />)
    expect(getByTestId("tick").textContent).toBe("0")
    act(() => void jest.advanceTimersByTime(160))
    expect(getByTestId("tick").textContent).toBe("2")
  })

  it("subscribes no timer while inactive", () => {
    render(<Probe active={false} />)
    expect(animationClock.timerCount).toBe(0)
    act(() => void jest.advanceTimersByTime(400))
    expect(animationClock.timerCount).toBe(0)
  })

  it("mounts a second component onto the frame the first is already on", () => {
    const first = render(<Probe active />)
    act(() => void jest.advanceTimersByTime(240))
    const second = render(<Probe active />)
    // Both spinners must draw the same glyph. A fresh subscriber that restarted
    // at 0 is exactly the drift the shared clock exists to remove.
    const read = (view: RenderResult) => within(view.container).getByTestId("tick").textContent
    expect(read(second)).toBe(read(first))
    expect(animationClock.timerCount).toBe(1)
  })

  it("releases the clock when the component unmounts", () => {
    const { unmount } = render(<Probe active />)
    expect(animationClock.timerCount).toBe(1)
    unmount()
    expect(animationClock.timerCount).toBe(0)
  })
})
