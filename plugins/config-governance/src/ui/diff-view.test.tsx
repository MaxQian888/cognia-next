/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { DiffView } from "./diff-view"

describe("DiffView", () => {
  it("renders removed, added and context lines with numbers and markers", () => {
    render(
      <DiffView
        label="Change"
        lines={[
          { kind: "context", line: 1, text: "keep" },
          { kind: "removed", line: 2, text: "old" },
          { kind: "added", line: 2, text: "" },
        ]}
      />
    )
    const diff = screen.getByLabelText("Change")
    const rows = diff.querySelectorAll("[data-kind]")
    expect([...rows].map((row) => row.getAttribute("data-kind"))).toEqual([
      "context",
      "removed",
      "added",
    ])
    expect(rows[1]!.textContent).toBe("2−old")
    expect(rows[2]!.textContent).toBe("2+ ")
  })
})
