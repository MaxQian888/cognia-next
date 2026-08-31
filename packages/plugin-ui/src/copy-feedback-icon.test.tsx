import { render } from "@testing-library/react"

import { CopyFeedbackIcon } from "./copy-feedback-icon"

describe("CopyFeedbackIcon", () => {
  it("exposes idle and copied states without an accessible duplicate label", () => {
    const { container, rerender } = render(<CopyFeedbackIcon copied={false} />)
    expect(container.querySelector('[data-slot="copy-feedback-icon"]')).toHaveAttribute(
      "data-state",
      "idle"
    )
    rerender(<CopyFeedbackIcon copied />)
    expect(container.querySelector('[data-slot="copy-feedback-icon"]')).toHaveAttribute(
      "data-state",
      "copied"
    )
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true")
  })
})
