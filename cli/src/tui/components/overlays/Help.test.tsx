import React from "react"
import { render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { Help } from "./Help"

describe("Help", () => {
  beforeEach(() => __resetInk())

  it("renders the command catalog and key hints", () => {
    const { container } = render(<Help onClose={() => {}} />)
    const text = container.textContent ?? ""
    expect(text).toContain("Commands")
    expect(text).toContain("/model")
    expect(text).toContain("Shift+Enter")
  })

  it("closes on Enter", () => {
    const onClose = jest.fn()
    render(<Help onClose={onClose} />)
    __fireInput("", { return: true })
    expect(onClose).toHaveBeenCalled()
  })
})
