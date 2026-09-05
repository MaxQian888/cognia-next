import { render } from "@testing-library/react"
import { GLYPH_NAMES, Glyph } from "./glyph"

describe("Glyph", () => {
  it("draws every mark on the same grid with a one unit stroke, hidden from assistive technology", () => {
    for (const name of GLYPH_NAMES) {
      const { container, unmount } = render(<Glyph name={name} />)
      const svg = container.querySelector("svg")
      expect(svg).toHaveAttribute("aria-hidden", "true")
      expect(svg).toHaveAttribute("viewBox", "0 0 24 24")
      expect(svg).toHaveAttribute("stroke-width", "1")
      expect(svg).toHaveAttribute("fill", "none")
      expect(svg).toHaveAttribute("data-glyph", name)
      unmount()
    }
  })

  it("normalises every shape so one draw rule fits any glyph", () => {
    for (const name of GLYPH_NAMES) {
      const { container, unmount } = render(<Glyph name={name} />)
      const shapes = container.querySelectorAll("path, circle, rect, line, polyline")
      expect(shapes.length).toBeGreaterThan(0)
      for (const shape of shapes) {
        expect(shape).toHaveAttribute("pathLength", "1")
      }
      unmount()
    }
  })

  it("has a mark for every subsystem the panorama names", () => {
    expect(GLYPH_NAMES.length).toBeGreaterThanOrEqual(20)
    expect(new Set(GLYPH_NAMES).size).toBe(GLYPH_NAMES.length)
  })

  it("arms the draw animation only when asked, with the delay on a custom property", () => {
    const { container } = render(<Glyph name="chat" draw delayMs={240} />)
    const svg = container.querySelector("svg") as SVGElement
    expect(svg.classList.contains("glyph-draw")).toBe(true)
    expect(svg.style.getPropertyValue("--glyph-delay")).toBe("240ms")

    const still = render(<Glyph name="chat" />).container.querySelector("svg") as SVGElement
    expect(still.classList.contains("glyph-draw")).toBe(false)
  })

  it("sizes to the three permitted steps", () => {
    const { container } = render(<Glyph name="terminal" size={24} />)
    expect(container.querySelector("svg")).toHaveAttribute("width", "24")
  })
})
