import React from "react"
import { render } from "@testing-library/react"
import type { DOMElement } from "ink"

import { ScrollView, measuredHeight } from "./ScrollView"

describe("measuredHeight", () => {
  it("returns 0 for a node that isn't laid out yet", () => {
    expect(measuredHeight(null)).toBe(0)
  })

  it("returns the measured height for a laid-out node", () => {
    // The ink mock's measureElement returns a fixed 80×24 box.
    expect(measuredHeight({} as DOMElement)).toBe(24)
  })
})

describe("ScrollView", () => {
  it("renders its children", () => {
    const { container } = render(
      <ScrollView offset={0} onMeasure={() => {}}>
        <span>hello transcript</span>
      </ScrollView>
    )
    expect(container.textContent).toContain("hello transcript")
  })

  it("reports measured content + viewport heights after layout", () => {
    const onMeasure = jest.fn()
    render(
      <ScrollView offset={3} onMeasure={onMeasure}>
        <span>body</span>
      </ScrollView>
    )
    // The ink mock's measureElement returns a fixed 80×24 box for both refs.
    expect(onMeasure).toHaveBeenCalledWith(24, 24)
  })

  it("re-measures on re-render", () => {
    const onMeasure = jest.fn()
    const { rerender } = render(
      <ScrollView offset={0} onMeasure={onMeasure}>
        <span>a</span>
      </ScrollView>
    )
    onMeasure.mockClear()
    rerender(
      <ScrollView offset={5} onMeasure={onMeasure}>
        <span>b</span>
      </ScrollView>
    )
    expect(onMeasure).toHaveBeenCalled()
  })
})
