/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

import { JumpFlash } from "./jump-flash"
import { useSettingsStore } from "@/stores/settings/settings-store"

beforeEach(() => {
  useSettingsStore.setState({ settings: {} as never })
})

describe("JumpFlash", () => {
  it("paints a wash and a leading bar over the row", () => {
    const { container } = render(<JumpFlash nonce={1} holdMs={1200} />)
    // The wash reads the whole row; the bar gives the eye an edge to catch in
    // a wide reading column where a faint tint alone is easy to miss.
    expect(container.querySelector(".bg-primary\\/10")).not.toBeNull()
    expect(container.querySelector(".bg-primary")).not.toBeNull()
  })

  it("is inert to pointers and hidden from assistive tech", () => {
    // It is decoration confirming a navigation the user just performed; the
    // navigation itself is what screen readers should follow. It also sits on
    // top of the message, so it must not eat clicks on the row's own controls.
    render(<JumpFlash nonce={1} holdMs={1200} />)
    const mark = screen.getByTestId("jump-flash")
    expect(mark).toHaveAttribute("aria-hidden", "true")
    expect(mark.className).toContain("pointer-events-none")
  })

  it("surfaces the nonce so a repeat jump remounts the animation", () => {
    const { rerender } = render(<JumpFlash nonce={1} holdMs={1200} />)
    expect(screen.getByTestId("jump-flash")).toHaveAttribute("data-jump-flash-nonce", "1")

    rerender(<JumpFlash nonce={2} holdMs={1200} />)
    expect(screen.getByTestId("jump-flash")).toHaveAttribute("data-jump-flash-nonce", "2")
  })

  it("holds the mark flat when motion is reduced", () => {
    useSettingsStore.setState({ settings: { motion: { reduce: true, speed: 1 } } as never })
    render(<JumpFlash nonce={1} holdMs={1200} />)
    const mark = screen.getByTestId("jump-flash")

    // Reduced motion still needs "where did I land?" answered — the mark is
    // held at full strength (no fade target) and unmounted by the hook instead.
    for (const child of Array.from(mark.children)) {
      expect((child as HTMLElement).style.opacity).toBe("")
    }
  })

  it("fades out over exactly the hold window when motion is allowed", () => {
    render(<JumpFlash nonce={1} holdMs={1200} />)
    const mark = screen.getByTestId("jump-flash")
    // The motion mock lands `animate` straight into inline style, so the
    // end-state is assertable: both layers must be heading to fully transparent
    // rather than lingering after the hook unmounts them.
    for (const child of Array.from(mark.children)) {
      expect((child as HTMLElement).style.opacity).toBe("0")
    }
  })
})
