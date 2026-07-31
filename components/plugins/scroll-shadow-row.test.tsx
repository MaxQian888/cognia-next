/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { ScrollShadowRow } from "./scroll-shadow-row"

describe("ScrollShadowRow", () => {
  it("renders children inside a scroller with the default test id", () => {
    render(
      <ScrollShadowRow>
        <span data-testid="child">hello</span>
      </ScrollShadowRow>
    )
    expect(screen.getByTestId("child")).toBeInTheDocument()
    expect(screen.getByTestId("scroll-shadow-row-scroller")).toHaveClass("scroll-fade-x")
  })

  it("uses a custom testId prefix on the scroller", () => {
    render(
      <ScrollShadowRow testId="my-prefix">
        <span>x</span>
      </ScrollShadowRow>
    )
    expect(screen.getByTestId("my-prefix-scroller")).toBeInTheDocument()
  })

  it("keeps edge fades CSS-only when the scroller overflows", () => {
    render(
      <ScrollShadowRow testId="t">
        <span>x</span>
      </ScrollShadowRow>
    )
    const scroller = screen.getByTestId("t-scroller")
    Object.defineProperty(scroller, "scrollLeft", { configurable: true, get: () => 0 })
    Object.defineProperty(scroller, "clientWidth", { configurable: true, get: () => 100 })
    Object.defineProperty(scroller, "scrollWidth", { configurable: true, get: () => 400 })
    scroller.dispatchEvent(new Event("scroll"))
    expect(screen.queryByTestId("t-fade-left")).not.toBeInTheDocument()
    expect(screen.queryByTestId("t-fade-right")).not.toBeInTheDocument()
  })

  it("applies className to the outer wrapper and scrollerClassName to the scroller", () => {
    render(
      <ScrollShadowRow testId="t" className="outer-class" scrollerClassName="-mx-1 px-1">
        <span>x</span>
      </ScrollShadowRow>
    )
    const scroller = screen.getByTestId("t-scroller")
    expect(scroller.className).toContain("-mx-1")
    expect(scroller.className).toContain("px-1")
    expect(scroller.parentElement).toHaveClass("outer-class")
  })
})
