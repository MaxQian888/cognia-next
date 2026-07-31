import React from "react"
import { render } from "@testing-library/react"

import { FindBar } from "./FindBar"

describe("FindBar", () => {
  it("prompts to search when the query is empty", () => {
    const { container } = render(<FindBar query="" matchCount={0} matchIndex={0} />)
    const text = container.textContent ?? ""
    expect(text).toContain("type to search")
    expect(text).toContain("esc close")
  })

  it("shows the 1-based position over the total when there are matches", () => {
    const { container } = render(<FindBar query="world" matchCount={3} matchIndex={1} />)
    const text = container.textContent ?? ""
    expect(text).toContain("world")
    expect(text).toContain("2/3")
  })

  it("reports no matches for a non-empty query with zero hits", () => {
    const { container } = render(<FindBar query="zzz" matchCount={0} matchIndex={0} />)
    const text = container.textContent ?? ""
    expect(text).toContain("No matches")
  })
})
