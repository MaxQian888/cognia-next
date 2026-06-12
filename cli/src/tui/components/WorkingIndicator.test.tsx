import React from "react"
import { render } from "@testing-library/react"

import { WorkingIndicator } from "./WorkingIndicator"
import { SPINNER_VERBS } from "../format/spinner-verbs"

describe("WorkingIndicator", () => {
  it("shows the first verb when streaming starts", () => {
    const { container } = render(<WorkingIndicator turnStatus="streaming" />)
    expect(container.textContent).toContain(SPINNER_VERBS[0])
  })

  it("shows a static 'stopping' word while aborting", () => {
    const { container } = render(<WorkingIndicator turnStatus="aborting" />)
    expect(container.textContent).toBe("stopping")
  })

  it("renders a verb even when idle (the footer hides it, but the word is safe)", () => {
    const { container } = render(<WorkingIndicator turnStatus="idle" />)
    expect(container.textContent).toContain(SPINNER_VERBS[0])
  })
})
