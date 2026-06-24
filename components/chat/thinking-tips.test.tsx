import { render } from "@testing-library/react"

const flowMotion = { reduce: false, speed: 1 }
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => flowMotion,
}))

import { ThinkingTips } from "./thinking-tips"

describe("ThinkingTips", () => {
  beforeEach(() => {
    flowMotion.reduce = false
    flowMotion.speed = 1
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
})
