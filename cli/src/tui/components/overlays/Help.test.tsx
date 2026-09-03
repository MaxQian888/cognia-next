import React from "react"
import { render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { Help, helpNameColumn } from "./Help"

describe("helpNameColumn", () => {
  it("sizes the column to the longest name, clamped at both ends", () => {
    // Short catalogue: the floor keeps the descriptions off the names.
    expect(helpNameColumn(["help", "clear"])).toBe(12)
    // A 12-character name needs its slash plus a gutter.
    expect(helpNameColumn(["help", "capabilities"])).toBe(14)
    // One pathological name cannot push every description off a narrow panel.
    expect(helpNameColumn(["a-very-long-command-name"])).toBe(18)
    expect(helpNameColumn([])).toBe(12)
  })
})

describe("Help", () => {
  beforeEach(() => __resetInk())

  it("renders the command catalog and key hints", () => {
    const { container } = render(<Help onClose={() => {}} viewportRows={16} />)
    const text = container.textContent ?? ""
    expect(text).toContain("Commands")
    expect(text).toContain("/model")
    expect(text).toContain("Shift+Enter")
    expect(text).toContain("PgUp/PgDn scroll")
    expect(text).toContain("esc close")
  })

  it("closes on Enter", () => {
    const onClose = jest.fn()
    render(<Help onClose={onClose} />)
    __fireInput("", { return: true })
    expect(onClose).toHaveBeenCalled()
  })
})
