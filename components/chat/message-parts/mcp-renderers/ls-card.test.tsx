/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
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
  it("renders the directory header line and one row per entry", () => {
    render(<LsCard part={part({ path: "." }, "D:/proj\nsrc/\npackage.json\nREADME.md")} />)
    expect(screen.getByTestId("mcp-ls-path")).toHaveTextContent("D:/proj")
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

  it("falls back to the input path while output is still pending", () => {
    render(<LsCard part={part({ path: "src" }, undefined)} />)
    expect(screen.getByTestId("mcp-ls-path")).toHaveTextContent("src")
  })
})
