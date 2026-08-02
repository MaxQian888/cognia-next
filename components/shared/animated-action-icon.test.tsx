/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render } from "@testing-library/react"
import { forwardRef, useImperativeHandle, useState } from "react"

import { Button } from "@/components/ui/button"
import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  AnimatedActionIcon,
  CopyFeedbackIcon,
  type AnimatedIconHandle,
  type AnimatedIconProps,
} from "./animated-action-icon"

const TestIcon = forwardRef<AnimatedIconHandle, AnimatedIconProps>(function TestIcon(props, ref) {
  const [animation, setAnimation] = useState("normal")

  useImperativeHandle(ref, () => ({
    startAnimation: () => setAnimation("animate"),
    stopAnimation: () => setAnimation("normal"),
  }))

  return <div {...props} data-animation={animation} data-testid="test-icon" />
})

describe("AnimatedActionIcon", () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: { motion: { reduce: false, speed: 1 } } as never })
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("animates from the enclosing action on hover and focus", () => {
    const { getByRole, getByTestId } = render(
      <Button aria-label="Run">
        <AnimatedActionIcon icon={TestIcon} />
      </Button>
    )
    const button = getByRole("button", { name: "Run" })
    const icon = getByTestId("test-icon")

    fireEvent.mouseEnter(button)
    expect(icon).toHaveAttribute("data-animation", "animate")
    fireEvent.mouseLeave(button)
    expect(icon).toHaveAttribute("data-animation", "normal")

    fireEvent.focus(button)
    expect(icon).toHaveAttribute("data-animation", "animate")
    fireEvent.blur(button)
    expect(icon).toHaveAttribute("data-animation", "normal")
  })

  it("plays once when its state key changes and then returns to normal", () => {
    jest.useFakeTimers()
    const { getByTestId, rerender } = render(
      <AnimatedActionIcon icon={TestIcon} animateOnChange={false} />
    )

    rerender(<AnimatedActionIcon icon={TestIcon} animateOnChange />)
    expect(getByTestId("test-icon")).toHaveAttribute("data-animation", "animate")

    act(() => jest.runOnlyPendingTimers())
    expect(getByTestId("test-icon")).toHaveAttribute("data-animation", "normal")
  })

  it("clears a pending state animation when unmounted", () => {
    jest.useFakeTimers()
    const { rerender, unmount } = render(
      <AnimatedActionIcon icon={TestIcon} animateOnChange={false} />
    )

    rerender(<AnimatedActionIcon icon={TestIcon} animateOnChange />)
    expect(jest.getTimerCount()).toBe(1)
    unmount()
    expect(jest.getTimerCount()).toBe(0)
  })

  it("suppresses hover and state animations when motion is reduced", () => {
    useSettingsStore.setState({ settings: { motion: { reduce: true, speed: 1 } } as never })
    const { getByRole, getByTestId, rerender } = render(
      <Button aria-label="Run">
        <AnimatedActionIcon icon={TestIcon} animateOnChange={false} />
      </Button>
    )

    fireEvent.mouseEnter(getByRole("button", { name: "Run" }))
    rerender(
      <Button aria-label="Run">
        <AnimatedActionIcon icon={TestIcon} animateOnChange />
      </Button>
    )

    expect(getByTestId("test-icon")).toHaveAttribute("data-animation", "normal")
  })
})

describe("CopyFeedbackIcon", () => {
  it("switches from the copy glyph to the check glyph after a successful copy", () => {
    const { container, rerender } = render(<CopyFeedbackIcon copied={false} />)
    expect(container.querySelector('[data-slot="copy-feedback-icon"] rect')).toBeTruthy()

    rerender(<CopyFeedbackIcon copied />)
    expect(container.querySelector('[data-slot="copy-feedback-icon"]')).toHaveAttribute(
      "data-state",
      "copied"
    )
    expect(container.querySelector('[data-slot="copy-feedback-icon"] rect')).toBeNull()
  })
})
