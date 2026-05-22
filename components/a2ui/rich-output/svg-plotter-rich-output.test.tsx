/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react"
import { SvgPlotterRichOutput } from "./svg-plotter-rich-output"

describe("SvgPlotterRichOutput", () => {
  it("renders an SVG with the requested height", () => {
    const { container } = render(<SvgPlotterRichOutput points={[]} height={200} />)
    const svg = container.querySelector("svg")
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute("height")).toBe("200")
    expect(svg?.getAttribute("viewBox")).toContain("200")
  })

  it("paints axes with the muted-foreground CSS var so they track the theme", () => {
    const { container } = render(<SvgPlotterRichOutput points={[{ x: 0, y: 0 }]} />)
    const axes = container.querySelectorAll("line")
    expect(axes.length).toBe(2)
    for (const axis of Array.from(axes)) {
      expect(axis.getAttribute("stroke")).toBe("var(--muted-foreground)")
    }
  })

  it("paints the plot line with the primary CSS var", () => {
    const { container } = render(
      <SvgPlotterRichOutput
        points={[
          { x: 0, y: 0 },
          { x: 1, y: 1 },
          { x: 2, y: 4 },
        ]}
      />
    )
    const path = container.querySelector("path")
    expect(path).not.toBeNull()
    expect(path?.getAttribute("stroke")).toBe("var(--primary)")
    expect(path?.getAttribute("d")).toBeTruthy()
  })

  it("emits an empty path when given no points (no NaN coordinates)", () => {
    const { container } = render(<SvgPlotterRichOutput points={[]} />)
    const path = container.querySelector("path")
    expect(path?.getAttribute("d")).toBe("")
  })
})
