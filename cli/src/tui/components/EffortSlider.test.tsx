import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { EffortSlider } from "./EffortSlider"
import { ThemeProvider } from "../theme/context"
import { BUILTIN_THEMES } from "../theme/builtins"
import { absoluteTopLeft } from "../input/element-position"

jest.mock("../input/element-position", () => ({ absoluteTopLeft: jest.fn(() => null) }))
const mockPos = absoluteTopLeft as jest.Mock

const wrap = (el: React.ReactElement) =>
  render(<ThemeProvider palette={BUILTIN_THEMES.ansi}>{el}</ThemeProvider>)

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
  beforeEach(() => {
    __resetInk()
    mockPos.mockReturnValue(null)
  })

  it("clicking the gauge track jumps to that tier (mouse scroll mode)", () => {
    mockPos.mockReturnValue({ top: 0, left: 0 })
    const onConfirm = jest.fn()
    wrap(<EffortSlider {...props({ onConfirm })} />)
    // gauge row = 0-based 3 (SGR row 4); track starts at 0-based col 11 (SGR 12).
    press("[<0;12;4M") // first track cell → tier index 0
    press("", { return: true })
    expect(onConfirm).toHaveBeenCalledWith({ off: false, index: 0 })
  })

  it("clicking the off-checkbox row selects the model default", () => {
    mockPos.mockReturnValue({ top: 0, left: 0 })
    const onConfirm = jest.fn()
    wrap(<EffortSlider {...props({ onConfirm })} />)
    press("[<0;5;3M") // off row = 0-based row 2 (SGR row 3)
    press("", { return: true })
    expect(onConfirm).toHaveBeenCalledWith({ off: true, index: 2 })
  })

  it("the mouse wheel nudges the tier", () => {
    mockPos.mockReturnValue({ top: 0, left: 0 })
    const onConfirm = jest.fn()
    wrap(<EffortSlider {...props({ index: 2, onConfirm })} />)
    press("[<64;1;1M") // wheel up → index 1
    press("", { return: true })
    expect(onConfirm).toHaveBeenCalledWith({ off: false, index: 1 })
  })

  it("renders the title, off row, slider labels and the focused-tier description", () => {
    const { container } = wrap(<EffortSlider {...props()} />)
    const text = container.textContent ?? ""
    expect(text).toContain("Reasoning effort")
    expect(text).toContain("Use model default (off)")
    expect(text).toContain("Faster")
    expect(text).toContain("Smarter")
    for (const lvl of ["low", "medium", "high", "xhigh", "max", "ultracode"]) {
      expect(text).toContain(lvl)
    }
    // index 2 = "high" → its description, NOT the old always-on "xhigh + workflows".
    expect(text).toContain("deeper reasoning")
    expect(text).not.toContain("xhigh + workflows")
    expect(text).toContain("Enter")
    expect(text).toContain("Esc")
  })

  it("shows the ultracode description (workflow coupling) when ultracode is focused", () => {
    const { container } = wrap(<EffortSlider {...props({ index: 5 })} />)
    expect(container.textContent ?? "").toContain("dynamic workflow tools")
  })

  it("shows an inline warning when the active model doesn't support effort", () => {
    const { container } = wrap(
      <EffortSlider {...props()} supported={false} modelLabel="claude-haiku-4-5" />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("doesn't support thinking levels")
    expect(text).toContain("claude-haiku-4-5")
  })

  it("hides the unsupported warning when off is checked", () => {
    const { container } = wrap(<EffortSlider {...props({ off: true })} supported={false} />)
    expect(container.textContent ?? "").not.toContain("doesn't support thinking levels")
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

  it("an arrow engages the slider even when the off checkbox has focus", () => {
    const onConfirm = jest.fn()
    // Seeded off=true → focus starts on the off checkbox. A right-arrow should
    // clear off and move the slider without needing Tab first.
    wrap(<EffortSlider {...props({ off: true, index: 2, onConfirm })} />)
    press("", { rightArrow: true })
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

  it("a digit jumps directly to that tier (1-based) and confirms", () => {
    const onConfirm = jest.fn()
    wrap(<EffortSlider {...props({ index: 0, onConfirm })} />)
    press("4") // tier 4 → index 3 (xhigh)
    press("", { return: true })
    expect(onConfirm).toHaveBeenCalledWith({ off: false, index: 3 })
  })

  it("a digit clears off and engages the slider", () => {
    const onConfirm = jest.fn()
    wrap(<EffortSlider {...props({ off: true, index: 0, onConfirm })} />)
    press("6") // ultracode
    press("", { return: true })
    expect(onConfirm).toHaveBeenCalledWith({ off: false, index: 5 })
  })

  it("ignores a digit that names no tier (>levels)", () => {
    const onConfirm = jest.fn()
    wrap(<EffortSlider {...props({ index: 2, onConfirm })} />)
    press("9") // only 6 tiers → no-op
    press("", { return: true })
    expect(onConfirm).toHaveBeenCalledWith({ off: false, index: 2 })
  })

  it("'0' selects off without changing the slider index", () => {
    const onConfirm = jest.fn()
    wrap(<EffortSlider {...props({ off: false, index: 2, onConfirm })} />)
    press("0")
    press("", { return: true })
    expect(onConfirm).toHaveBeenCalledWith({ off: true, index: 2 })
  })

  it("uses the full inline scale on a wide terminal", () => {
    const { container } = wrap(<EffortSlider {...props()} width={100} />)
    const text = container.textContent ?? ""
    expect(text).toContain("ultracode")
    expect(text).not.toContain("Tier")
  })

  it("collapses to a compact position readout on a narrow terminal", () => {
    const { container } = wrap(<EffortSlider {...props({ index: 2 })} width={40} />)
    const text = container.textContent ?? ""
    expect(text).toContain("Tier")
    expect(text).toContain("3/6") // index 2 → 3rd of 6 tiers
    expect(text).toContain("Faster")
    expect(text).toContain("Smarter")
  })
})
