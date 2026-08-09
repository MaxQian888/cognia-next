/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

let reduced = false
jest.mock("motion/react", () => ({
  useReducedMotion: () => reduced,
}))

import { ContextTrace } from "./context-trace"

const copy = {
  srLabel: "Context signals",
  items: [
    { key: "repository", label: "Repository read" },
    { key: "branch", label: "Branch identified" },
    { key: "files", label: "Files scanned" },
  ],
}

describe("ContextTrace", () => {
  beforeEach(() => {
    reduced = false
  })

  it("renders all trace items", () => {
    render(<ContextTrace copy={copy} />)
    // Marquee repeats items, so use getAllByText
    expect(screen.getAllByText("Repository read").length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText("Branch identified").length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText("Files scanned").length).toBeGreaterThanOrEqual(1)
  })

  it("provides a screen-reader heading", () => {
    render(<ContextTrace copy={copy} />)
    const heading = screen.getByRole("heading", { level: 2 })
    expect(heading).toHaveTextContent("Context signals")
    expect(heading).toHaveClass("sr-only")
  })

  describe("reduced motion", () => {
    beforeEach(() => {
      reduced = true
    })

    it("renders a static row without marquee animation", () => {
      const { container } = render(<ContextTrace copy={copy} />)
      // No marquee animation class when reduced motion is active
      expect(container.querySelector(".animate-marquee")).toBeNull()
      // All items still visible
      expect(screen.getByText("Repository read")).toBeInTheDocument()
      expect(screen.getByText("Branch identified")).toBeInTheDocument()
      expect(screen.getByText("Files scanned")).toBeInTheDocument()
    })
  })
})
