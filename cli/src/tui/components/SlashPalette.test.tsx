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

  it("shows the active search and command argument hints", () => {
    const { container } = render(
      <SlashPalette
        query="co"
        matches={[
          {
            name: "copy",
            description: "copy a reply",
            argumentHint: "[n|code|tool|user]",
            category: "chat",
          },
        ]}
        index={0}
        width={50}
      />
    )
    expect(container.textContent).toContain("Search: co")
    expect(container.textContent).toContain("/copy [n|code|tool|user]")
  })

  it("renders nothing when there are no matches", () => {
    const { container } = render(<SlashPalette matches={[]} index={0} />)
    expect(container.textContent).toBe("")
  })

  it("windows a long match list and shows scroll hints", () => {
    const matches = Array.from({ length: 20 }, (_, i) => ({
      name: `cmd${i}`,
      description: `does ${i}`,
      category: "config" as const,
    }))
    const { container } = render(<SlashPalette matches={matches} index={15} maxRows={5} />)
    const text = container.textContent ?? ""
    expect(text).toContain("❯ /cmd15") // selection visible
    expect(text).toContain("↑") // hidden above
    expect(text).toContain("↓") // hidden below
    expect(text).not.toContain("/cmd0 ") // scrolled out of view
  })
})
