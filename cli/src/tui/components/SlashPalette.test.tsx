import React from "react"
import { render } from "@testing-library/react"

import { SlashPalette } from "./SlashPalette"

describe("SlashPalette", () => {
  it("renders matches with the highlighted row and descriptions", () => {
    const { container } = render(
      <SlashPalette
        matches={[
          { name: "model", description: "switch the model", category: "config" },
          { name: "mode", description: "switch the mode", category: "config" },
        ]}
        index={1}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("/model")
    expect(text).toContain("switch the model")
    expect(text).toContain("❯ /mode")
  })

  it("renders nothing when there are no matches", () => {
    const { container } = render(<SlashPalette matches={[]} index={0} />)
    expect(container.textContent).toBe("")
  })
})
