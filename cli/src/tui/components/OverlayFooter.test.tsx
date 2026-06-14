import React from "react"
import { render } from "@testing-library/react"
import { __resetInk } from "ink"

import { OverlayFooter, DEFAULT_OVERLAY_HINT } from "./OverlayFooter"

describe("OverlayFooter", () => {
  beforeEach(() => __resetInk())

  it("renders the default hint", () => {
    const { container } = render(<OverlayFooter />)
    expect(container.textContent ?? "").toContain(DEFAULT_OVERLAY_HINT)
  })

  it("renders a custom hint", () => {
    const { container } = render(<OverlayFooter hint="Enter choose · Esc deny" />)
    expect(container.textContent ?? "").toContain("Enter choose · Esc deny")
  })
})
