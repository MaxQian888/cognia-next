import React from "react"
import { render } from "@testing-library/react"

import { InspectOverlay } from "./InspectOverlay"
import { ThemeProvider } from "../../theme/context"
import { BUILTIN_THEMES } from "../../theme/builtins"
import type { InspectItem } from "../../state/types"

const items: InspectItem[] = [
  { cellId: "1", label: "✓ read", summary: "/a.ts", lines: 12, isError: false },
  { cellId: "2", label: "! ls", summary: "shell", lines: 0, isError: false },
]

function renderOverlay(index = 0) {
  return (
    render(
      <ThemeProvider palette={BUILTIN_THEMES.ansi}>
        <InspectOverlay
          items={items}
          index={index}
          onMove={() => {}}
          onSelect={() => {}}
          onCancel={() => {}}
        />
      </ThemeProvider>
    ).container.textContent ?? ""
  )
}

describe("InspectOverlay", () => {
  it("renders each inspectable row with its label + summary", () => {
    const text = renderOverlay()
    expect(text).toContain("read")
    expect(text).toContain("/a.ts")
    expect(text).toContain("! ls")
  })

  it("shows a line-count hint only when the result has lines", () => {
    const text = renderOverlay()
    expect(text).toContain("12 lines")
  })

  it("shows the full-output footer hint", () => {
    expect(renderOverlay()).toContain("view full output")
  })
})
