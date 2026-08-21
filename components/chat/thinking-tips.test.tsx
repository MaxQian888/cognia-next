import { render } from "@testing-library/react"

const flowMotion = { reduce: false, durationScale: 1 }
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => flowMotion,
}))

import { ThinkingTips } from "./thinking-tips"

describe("ThinkingTips", () => {
  beforeEach(() => {
    flowMotion.reduce = false
    flowMotion.durationScale = 1
  })

  it("renders nothing when there are no tips", () => {
    const { container } = render(<ThinkingTips tips={[]} index={0} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders the tip at the given index", () => {
    const { getByRole } = render(<ThinkingTips tips={["alpha", "beta", "gamma"]} index={1} />)
    expect(getByRole("note").textContent).toContain("beta")
  })

  it("wraps the index modulo the tip count", () => {
    const { getByRole } = render(<ThinkingTips tips={["alpha", "beta", "gamma"]} index={4} />)
    // 4 % 3 === 1 → "beta"
    expect(getByRole("note").textContent).toContain("beta")
  })

  it("handles a single tip without animation churn", () => {
    const { getByRole } = render(<ThinkingTips tips={["only"]} index={0} />)
    expect(getByRole("note").textContent).toContain("only")
  })

  it("renders the plain (non-animated) branch under reduced motion", () => {
    flowMotion.reduce = true
    const { getByRole } = render(<ThinkingTips tips={["alpha", "beta"]} index={0} />)
    expect(getByRole("note").textContent).toContain("alpha")
  })

  it("exposes a polite live region for screen readers", () => {
    const { getByRole } = render(<ThinkingTips tips={["alpha"]} index={0} />)
    expect(getByRole("note")).toHaveAttribute("aria-live", "polite")
  })

  it("holds a fixed two-line box whatever the tip's length", () => {
    // ADR-0138 — the tip rotates every 5s for the whole of a tool-heavy turn.
    // Tips of different lengths wrapped to one line or two, so the row's height
    // changed under the reply on every rotation. The box is now a constant.
    for (const tip of ["a", "a".repeat(400)]) {
      const { container, unmount } = render(<ThinkingTips tips={[tip]} index={0} />)
      expect(container.querySelector(".line-clamp-2")).toHaveClass("h-8")
      unmount()
    }
  })

  it("cross-fades tips in one grid cell, with no transform and no empty beat", () => {
    // `mode="wait"` left the cell empty between tips (a height change), and the
    // old crossfade translated on `y`. Both are gone: one cell, opacity only.
    const { getByRole } = render(<ThinkingTips tips={["alpha", "beta"]} index={0} />)
    const note = getByRole("note")
    expect(note).toHaveClass("grid")
    expect(note.firstElementChild).toHaveClass("col-start-1", "row-start-1")
  })
})
