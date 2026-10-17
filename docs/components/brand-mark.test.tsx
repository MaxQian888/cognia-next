/** @jest-environment jsdom */

import { render } from "@testing-library/react"
import { BrandMark } from "./brand-mark"

describe("BrandMark", () => {
  it("is decorative, so the word beside it is announced once", () => {
    const { container } = render(<BrandMark />)
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true")
  })

  it("draws the node in the shared accent token", () => {
    const { container } = render(<BrandMark size={18} />)
    const svg = container.querySelector("svg")
    expect(svg).toHaveAttribute("width", "18")
    expect(container.querySelector("circle")).toHaveAttribute("fill", "var(--cg-action)")
  })
})
