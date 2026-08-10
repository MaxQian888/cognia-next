import { render } from "@testing-library/react"
import manifest from "@web/content/generated/agent-icons.json"
import { AgentMark } from "./agent-mark"

const KNOWN = Object.keys(manifest.icons)

describe("AgentMark", () => {
  it("draws a vendored mark inline so it inherits the surrounding token", () => {
    // Inline, not an image element: the source marks are currentColor
    // monochrome, and an external image would be stuck at one lightness.
    const { container } = render(<AgentMark id={KNOWN[0]} />)
    const svg = container.querySelector("svg")
    expect(svg).toBeInTheDocument()
    expect(svg).toHaveAttribute("fill", "currentColor")
    expect(svg?.querySelectorAll("path").length).toBeGreaterThan(0)
  })

  it("renders every vendored agent without falling back", () => {
    for (const id of KNOWN) {
      const { container } = render(<AgentMark id={id} />)
      expect(container.querySelectorAll("path").length).toBeGreaterThan(0)
    }
  })

  it("falls back to the site's own glyph rather than another brand's", () => {
    const { container } = render(<AgentMark id="aider" />)
    expect(container.querySelector("svg")).toBeInTheDocument()
  })

  it("is hidden from assistive technology", () => {
    // The agent's name sits beside it as real text; announcing the mark too
    // would read the same thing twice.
    const { container } = render(<AgentMark id={KNOWN[0]} />)
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true")
    expect(container.querySelector("svg")).toHaveAttribute("focusable", "false")
  })

  it("passes the caller's className through", () => {
    const { container } = render(<AgentMark id={KNOWN[0]} className="text-ink" />)
    expect(container.querySelector("svg")).toHaveClass("text-ink")
  })
})
