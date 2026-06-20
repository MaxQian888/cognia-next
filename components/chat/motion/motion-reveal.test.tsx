/**
 * @jest-environment jsdom
 */

import { render, renderHook } from "@testing-library/react"

import { MotionReveal, useFlowMotion } from "./motion-reveal"
import { useSettingsStore } from "@/stores/settings/settings-store"

describe("useFlowMotion", () => {
  it("reads reduce + speed from settings", () => {
    useSettingsStore.setState({ settings: { motion: { reduce: true, speed: 1.5 } } as never })
    const { result } = renderHook(() => useFlowMotion())
    expect(result.current).toEqual({ reduce: true, speed: 1.5 })
  })

  it("defaults to no-reduce + default speed when unset", () => {
    useSettingsStore.setState({ settings: {} as never })
    const { result } = renderHook(() => useFlowMotion())
    expect(result.current.reduce).toBe(false)
    expect(result.current.speed).toBe(1)
  })
})

describe("MotionReveal", () => {
  it("renders a bare fragment (no wrapper) when reduced and no className", () => {
    useSettingsStore.setState({ settings: { motion: { reduce: true, speed: 1 } } as never })
    const { container } = render(
      <MotionReveal>
        <span data-testid="child">hi</span>
      </MotionReveal>
    )
    // First child is the span itself, not a wrapping div.
    expect((container.firstChild as HTMLElement)?.tagName).toBe("SPAN")
  })

  it("wraps in a plain div when reduced but a className is given", () => {
    useSettingsStore.setState({ settings: { motion: { reduce: true, speed: 1 } } as never })
    const { container } = render(
      <MotionReveal className="x">
        <span>hi</span>
      </MotionReveal>
    )
    const wrapper = container.firstChild as HTMLElement
    expect(wrapper.tagName).toBe("DIV")
    expect(wrapper.className).toBe("x")
  })

  it("renders an animated wrapper when motion is enabled", () => {
    useSettingsStore.setState({ settings: { motion: { reduce: false, speed: 1 } } as never })
    const { getByTestId, container } = render(
      <MotionReveal index={2}>
        <span data-testid="child">hi</span>
      </MotionReveal>
    )
    expect(getByTestId("child")).toBeTruthy()
    // motion.div produces a wrapping div element.
    expect((container.firstChild as HTMLElement)?.tagName).toBe("DIV")
  })

  it("renders children unwrapped when disabled and no className", () => {
    useSettingsStore.setState({ settings: { motion: { reduce: false, speed: 1 } } as never })
    const { container } = render(
      <MotionReveal disabled>
        <span data-testid="child">hi</span>
      </MotionReveal>
    )
    expect((container.firstChild as HTMLElement)?.tagName).toBe("SPAN")
  })
})
