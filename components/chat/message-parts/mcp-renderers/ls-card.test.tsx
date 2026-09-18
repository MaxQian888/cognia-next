/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"

import { LsCard } from "./ls-card"

const part = (input?: unknown, output?: unknown): ToolUIPart =>
  ({
    type: "tool-ls",
    toolCallId: "call",
    state: "output-available",
    input,
    output,
  }) as unknown as ToolUIPart

describe("LsCard", () => {
  it("renders one row per entry (the row above carries the directory)", () => {
    render(<LsCard part={part({ path: "." }, "D:/proj\nsrc/\npackage.json\nREADME.md")} />)
    expect(screen.getAllByTestId("mcp-ls-entry")).toHaveLength(3)
  })

  it("shows the empty state for a directory with no entries", () => {
    render(<LsCard part={part({ path: "empty" }, "D:/proj/empty")} />)
    expect(screen.queryAllByTestId("mcp-ls-entry")).toHaveLength(0)
  })

  it("returns null with neither output nor an input path", () => {
    const { container } = render(<LsCard part={part({}, "")} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing while output is still pending", () => {
    const { container } = render(<LsCard part={part({ path: "src" }, undefined)} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows a folder glyph for trailing-slash entries and a file glyph otherwise", () => {
    render(<LsCard part={part({ path: "." }, "D:/proj\nsrc/\nREADME.md")} />)
    const entries = screen.getAllByTestId("mcp-ls-entry")
    expect(entries[0].querySelector("[data-file-type]")).toHaveAttribute("data-file-type", "folder")
    expect(entries[1].querySelector("[data-file-type]")).toHaveAttribute(
      "data-file-type",
      "markdown"
    )
  })

  it("clamps a huge listing behind a show-all note", () => {
    const output = ["D:/proj", ...Array.from({ length: 250 }, (_, i) => `f${i}.ts`)].join("\n")
    render(<LsCard part={part({ path: "." }, output)} />)
    expect(screen.getAllByTestId("mcp-ls-entry")).toHaveLength(200)
    expect(screen.getByTestId("mcp-ls-clamped")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("mcp-ls-clamped-show-all"))
    expect(screen.getAllByTestId("mcp-ls-entry")).toHaveLength(250)
  })
})
