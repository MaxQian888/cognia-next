import React from "react"
import { render } from "@testing-library/react"

import { FileCompleter } from "./FileCompleter"

describe("FileCompleter", () => {
  it("renders completions with the highlighted row", () => {
    const { container } = render(<FileCompleter completions={["@src/", "@spec/"]} index={0} />)
    const text = container.textContent ?? ""
    expect(text).toContain("@src/")
    expect(text).toContain("@spec/")
    expect(text).toContain("❯ @src/")
  })

  it("renders nothing when there are no completions", () => {
    const { container } = render(<FileCompleter completions={[]} index={0} />)
    expect(container.textContent).toBe("")
  })
})
