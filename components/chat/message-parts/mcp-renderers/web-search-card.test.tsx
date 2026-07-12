/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"

import { WebSearchCard } from "./web-search-card"

const part = (input?: unknown, output?: unknown): ToolUIPart =>
  ({
    type: "tool-web_search",
    toolCallId: "call",
    state: "output-available",
    input,
    output,
  }) as unknown as ToolUIPart

describe("WebSearchCard", () => {
  it("renders the query and one external link per result", () => {
    render(
      <WebSearchCard
        part={part(
          { query: "cats" },
          {
            results: [
              { title: "A", url: "https://a.test/x" },
              { title: "B", url: "https://b.test/y" },
            ],
          }
        )}
      />
    )
    expect(screen.getByTestId("mcp-websearch-query")).toHaveTextContent("cats")
    const rows = screen.getAllByTestId("mcp-websearch-result")
    expect(rows).toHaveLength(2)
    const firstLink = screen.getByRole("link", { name: "A" })
    expect(firstLink).toHaveAttribute("href", "https://a.test/x")
    expect(firstLink).toHaveAttribute("target", "_blank")
  })

  it("returns null when there is neither a query nor results", () => {
    const { container } = render(<WebSearchCard part={part({}, {})} />)
    expect(container).toBeEmptyDOMElement()
  })
})
