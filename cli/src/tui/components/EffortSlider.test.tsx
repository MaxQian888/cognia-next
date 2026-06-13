import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { EffortSlider } from "./EffortSlider"
import { ThemeProvider } from "../theme/context"
import { BUILTIN_THEMES } from "../theme/builtins"

const wrap = (el: React.ReactElement) =>
  render(<ThemeProvider palette={BUILTIN_THEMES.classic}>{el}</ThemeProvider>)

/** Fire a key inside act() so React re-registers the handler with fresh state
 * before the next key (the ink mock re-adds the handler in a useEffect). */
function press(input: string, key?: Record<string, boolean>) {
  act(() => __fireInput(input, key))
}

/** Default props: off unchecked, slider at `high` (index 2). */
function props(over: Partial<React.ComponentProps<typeof EffortSlider>> = {}) {
  return {
    off: false,
    index: 2,
    onConfirm: jest.fn(),
    onCancel: jest.fn(),
    ...over,
  }
}

describe("EffortSlider", () => {
  beforeEach(() => __resetInk())

  it("renders the title, off row, slider labels and the ultracode sublabel", () => {
    const { container } = wrap(<EffortSlider {...props()} />)
    const text = container.textContent ?? ""
    expect(text).toContain("Effort")
    expect(text).toContain("Use model default (off)")
    expect(text).toContain("Faster")
    expect(text).toContain("Smarter")
    for (const lvl of ["low", "medium", "high", "xhigh", "max", "ultracode"]) {
      expect(text).toContain(lvl)
    }
    expect(text).toContain("xhigh + workflows")
    expect(text).toContain("Enter")
    expect(text).toContain("Esc")
  })

  it("shows the off checkbox checked when off=true", () => {
    const { container } = wrap(<EffortSlider {...props({ off: true })} />)
    expect(container.textContent ?? "").toContain("✓")
  })

  it("moves the slider right on → and confirms with the new index", () => {
    const onConfirm = jest.fn()
    wrap(<EffortSlider {...props({ index: 2, onConfirm })} />)
    press("", { rightArrow: true }) // high → xhigh
    press("", { return: true })
    expect(onConfirm).toHaveBeenCalledWith({ off: false, index: 3 })
  })

  it("moves the slider left on ← and clamps at the low end", () => {
    const onConfirm = jest.fn()
    wrap(<EffortSlider {...props({ index: 0, onConfirm })} />)
    press("", { leftArrow: true }) // already at low → stays
    press("", { return: true })
    expect(onConfirm).toHaveBeenCalledWith({ off: false, index: 0 })
  })

  it("clamps the slider at ultracode (the high end)", () => {
    const onConfirm = jest.fn()
    wrap(<EffortSlider {...props({ index: 5, onConfirm })} />)
    press("", { rightArrow: true }) // already at ultracode → stays
    press("", { return: true })
    expect(onConfirm).toHaveBeenCalledWith({ off: false, index: 5 })
  })

  it("Tab moves focus to the off checkbox; Space toggles it on", () => {
    const onConfirm = jest.fn()
    wrap(<EffortSlider {...props({ off: false, index: 2, onConfirm })} />)
    press("", { tab: true }) // focus → off checkbox
    press(" ") // toggle off on
    press("", { return: true })
    expect(onConfirm).toHaveBeenCalledWith({ off: true, index: 2 })
  })

  it("auto-clears off when the slider moves", () => {
    const onConfirm = jest.fn()
    wrap(<EffortSlider {...props({ off: true, index: 2, onConfirm })} />)
    // Focus starts on the slider when off is checked? No — moving the slider
    // requires slider focus. Tab back to the slider, then move.
    press("", { tab: true }) // off → slider
    press("", { rightArrow: true }) // moves + clears off
    press("", { return: true })
    expect(onConfirm).toHaveBeenCalledWith({ off: false, index: 3 })
  })

  it("Space on the slider focus does nothing (only toggles when focus is off)", () => {
    const onConfirm = jest.fn()
    wrap(<EffortSlider {...props({ off: false, index: 2, onConfirm })} />)
    press(" ") // focus is slider → no-op
    press("", { return: true })
    expect(onConfirm).toHaveBeenCalledWith({ off: false, index: 2 })
  })

  it("cancels on Esc", () => {
    const onCancel = jest.fn()
    wrap(<EffortSlider {...props({ onCancel })} />)
    press("", { escape: true })
    expect(onCancel).toHaveBeenCalled()
  })
})
