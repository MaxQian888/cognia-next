import { render, screen } from "@testing-library/react"

import { Progress } from "./progress"

const indicatorOf = (bar: HTMLElement) =>
  bar.querySelector<HTMLElement>("[data-slot='progress-indicator']")

describe("Progress", () => {
  it("exposes the progressbar role with the caller's name and value", () => {
    render(<Progress aria-label="Indexing" value={40} />)

    // aria-valuenow is the divergence from the host component, which swallows
    // `value` before Radix sees it. Pinned so the silent-to-screen-readers bug
    // cannot come back with the next upstream sync.
    const bar = screen.getByRole("progressbar", { name: "Indexing" })
    expect(bar).toHaveAttribute("data-slot", "progress")
    expect(bar).toHaveAttribute("aria-valuenow", "40")
    expect(bar).toHaveAttribute("aria-valuemax", "100")
    expect(bar).toHaveAttribute("data-state", "loading")
  })

  it("slides a full-width indicator instead of animating its width", () => {
    render(<Progress aria-label="Indexing" value={40} />)

    // Transform-only so a plugin ticking this per frame costs the host no
    // layout; a width animation here would be the silent regression.
    const indicator = indicatorOf(screen.getByRole("progressbar"))
    expect(indicator?.style.transform).toBe("translateX(-60%)")
    expect(indicator?.className).toContain("w-full")
    expect(indicator?.style.width).toBe("")
  })

  it("treats a missing value as zero rather than leaving the bar full", () => {
    render(<Progress aria-label="Indexing" />)

    const bar = screen.getByRole("progressbar")
    // Radix calls this indeterminate, but the indicator still has to land
    // somewhere — the fallback parks it fully off-screen.
    expect(bar).toHaveAttribute("data-state", "indeterminate")
    expect(bar).not.toHaveAttribute("aria-valuenow")
    expect(indicatorOf(bar)?.style.transform).toBe("translateX(-100%)")
  })

  it("parks the indicator off-screen at zero and flush at max", () => {
    const { rerender } = render(<Progress aria-label="Indexing" value={0} />)
    expect(indicatorOf(screen.getByRole("progressbar"))?.style.transform).toBe("translateX(-100%)")

    rerender(<Progress aria-label="Indexing" value={100} />)
    const bar = screen.getByRole("progressbar")
    expect(indicatorOf(bar)?.style.transform).toBe("translateX(-0%)")
    expect(bar).toHaveAttribute("data-state", "complete")
  })

  it("scales against a custom max when the plugin counts items, not percent", () => {
    render(<Progress aria-label="Indexing" max={50} value={25} />)

    const bar = screen.getByRole("progressbar")
    expect(bar).toHaveAttribute("aria-valuemax", "50")
    expect(bar).toHaveAttribute("aria-valuenow", "25")
    // Geometry follows `max` too — the host component divides by a hard-coded
    // 100 here and puts a half-done bar at 25%.
    expect(indicatorOf(bar)?.style.transform).toBe("translateX(-50%)")
  })

  it("clips the indicator so it cannot paint outside the track", () => {
    render(<Progress aria-label="Indexing" value={40} />)

    expect(screen.getByRole("progressbar").className).toContain("overflow-hidden")
  })

  it("merges caller classes onto the track instead of dropping them", () => {
    render(<Progress aria-label="Indexing" value={40} className="h-1 w-64" />)

    const bar = screen.getByRole("progressbar")
    expect(bar.className).toContain("w-64")
    // cn() resolved h-2 vs h-1 rather than emitting both.
    expect(bar.className).toContain("h-1")
    expect(bar.className).not.toContain("h-2")
  })
})

describe("Progress with input Radix rejects", () => {
  // Radix logs its own error for each of these before falling back. Silence it
  // so a legitimately noisy edge case does not look like a broken suite.
  let errorSpy: jest.SpyInstance

  beforeEach(() => {
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  it("falls back to percent semantics when max is unusable", () => {
    render(<Progress aria-label="Indexing" max={0} value={25} />)

    // Radix rejects a non-positive max and reverts to 100; the indicator has to
    // make the same choice or the bar disagrees with what it announces.
    expect(indicatorOf(screen.getByRole("progressbar"))?.style.transform).toBe("translateX(-75%)")
    expect(errorSpy).toHaveBeenCalled()
  })

  it("clamps an overshooting value instead of leaving a gap at the start", () => {
    render(<Progress aria-label="Indexing" max={10} value={12} />)

    // Happens transiently whenever `value` updates before its `max` catches up.
    // Radix drops back to indeterminate; the bar shows full rather than the
    // half-empty track an unclamped translate would produce.
    expect(indicatorOf(screen.getByRole("progressbar"))?.style.transform).toBe("translateX(-0%)")
  })
})
