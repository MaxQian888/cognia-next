import { render } from "@testing-library/react"
import { BrandMark } from "./brand-mark"

describe("BrandMark", () => {
  it("renders at the requested size", () => {
    const { container } = render(<BrandMark size={32} />)
    const svg = container.querySelector("svg")
    expect(svg).toHaveAttribute("width", "32")
    expect(svg).toHaveAttribute("height", "32")
  })

  it("is hidden from assistive technology", () => {
    // The brand link beside it already carries the word "Cognia".
    const { container } = render(<BrandMark />)
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true")
  })

  it("spends its only accent on a dot, never on a fill or a gradient", () => {
    // Spec §3.1: cyan is a line, a dot or a fill — and the mark must stay well
    // under the 5% single-screen budget. A gradient here would also break the
    // "no purple-blue AI gradient" rule the same section sets.
    const { container } = render(<BrandMark />)
    const accented = container.querySelectorAll('[fill="var(--color-action)"]')
    expect(accented).toHaveLength(1)
    expect(accented[0].tagName.toLowerCase()).toBe("circle")
    expect(container.querySelector("linearGradient")).toBeNull()
    expect(container.querySelector("radialGradient")).toBeNull()
  })

  it("inherits the theme everywhere else instead of shipping two copies", () => {
    const { container } = render(<BrandMark />)
    expect(container.querySelectorAll('[stroke="currentColor"]').length).toBeGreaterThan(0)
  })

  it("passes the caller's className through", () => {
    const { container } = render(<BrandMark className="text-ink" />)
    expect(container.querySelector("svg")).toHaveClass("text-ink")
  })
})
