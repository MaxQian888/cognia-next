import React from "react"
import { render } from "@testing-library/react"

import { DiffView } from "./DiffView"
import type { DiffLine } from "../markdown/types"

const lines: DiffLine[] = [
  { kind: "meta", text: "src/x.ts" },
  { kind: "del", text: "const a = 1", oldNo: 1 },
  { kind: "add", text: "const a = 2", newNo: 1 },
  { kind: "add", text: "const b = 3", newNo: 2 },
]

describe("DiffView", () => {
  it("renders meta + add/del lines with markers", () => {
    const { container } = render(<DiffView diff={lines} />)
    const text = container.textContent ?? ""
    expect(text).toContain("src/x.ts")
    expect(text).toContain("const a = 1")
    expect(text).toContain("const a = 2")
    expect(text).toContain("+ ")
    expect(text).toContain("- ")
  })

  it("caps to maxLines and summarizes the remainder", () => {
    const { container } = render(<DiffView diff={lines} maxLines={2} />)
    const text = container.textContent ?? ""
    // First two lines shown, the other two summarized.
    expect(text).toContain("src/x.ts")
    expect(text).toContain("… +2 more lines")
    expect(text).not.toContain("const b = 3")
  })
})
