import { render } from "@testing-library/react"
import { Icon } from "./icon"

function svgOf(container: HTMLElement) {
  const svg = container.querySelector("svg")
  if (!svg) throw new Error("no icon rendered")
  return svg
}

describe("Icon", () => {
  it("renders a glyph", () => {
    const { container } = render(<Icon name="check" />)
    expect(svgOf(container)).toBeInTheDocument()
  })

  it("stays out of the accessibility tree", () => {
    // Every icon on this site accompanies a label that already exists, so an
    // icon is never the accessible name of anything. This is also what keeps
    // the site's `getByRole(…, { name })` queries valid.
    const { container } = render(<Icon name="external" />)
    const svg = svgOf(container)
    expect(svg).toHaveAttribute("aria-hidden", "true")
    expect(svg).toHaveAttribute("focusable", "false")
  })

  it("draws at 1.5 stroke, not lucide's default 2", () => {
    // 2px glyphs beside the system's 1px hairlines is the single thing that
    // would make this read as a generic template.
    const { container } = render(<Icon name="check" />)
    expect(svgOf(container)).toHaveAttribute("stroke-width", "1.5")
  })

  it("defaults to 16px and honours the three allowed sizes", () => {
    const { container: base } = render(<Icon name="check" />)
    expect(svgOf(base)).toHaveAttribute("width", "16")

    const { container: small } = render(<Icon name="check" size={14} />)
    expect(svgOf(small)).toHaveAttribute("width", "14")

    const { container: large } = render(<Icon name="check" size={20} />)
    expect(svgOf(large)).toHaveAttribute("height", "20")
  })

  it("never fills, because the system is a line drawing", () => {
    const { container } = render(<Icon name="trust" />)
    expect(svgOf(container)).toHaveAttribute("fill", "none")
  })

  it("does not shrink inside a flex row", () => {
    const { container } = render(<Icon name="check" />)
    expect(svgOf(container).getAttribute("class")).toContain("shrink-0")
  })

  it("accepts a colour class from the call site", () => {
    const { container } = render(<Icon name="alert" className="text-approval" />)
    expect(svgOf(container).getAttribute("class")).toContain("text-approval")
  })
})
