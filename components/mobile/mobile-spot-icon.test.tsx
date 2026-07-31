/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { MobileSpotIcon } from "./mobile-spot-icon"

describe("<MobileSpotIcon />", () => {
  it("renders the requested transparent Cognia illustration as decorative media", () => {
    render(<MobileSpotIcon name="workflows" size={72} className="shrink-0" />)

    const image = screen.getByTestId("mobile-spot-icon-workflows")
    expect(image).toHaveAttribute(
      "src",
      "/icons/cognia-mobile-spots/png/workflows.png"
    )
    expect(image).toHaveAttribute("alt", "")
    expect(image).toHaveAttribute("aria-hidden", "true")
    expect(image).toHaveAttribute("width", "72")
    expect(image).toHaveAttribute("height", "72")
    expect(image).toHaveClass("shrink-0")
  })
})
