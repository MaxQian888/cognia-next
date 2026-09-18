/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"

import { WikiSearchCard } from "./wiki-search-card"

function part(output: unknown): ToolUIPart {
  return {
    type: "tool-wiki_search",
    toolCallId: "ws-call",
    state: "output-available",
    input: { query: "hooks" },
    output,
  } as unknown as ToolUIPart
}

describe("WikiSearchCard", () => {
  it("renders hit metadata", () => {
    render(
      <WikiSearchCard
        part={part({
          hits: [
            {
              slug: "hooks/overview",
              title: "Hooks overview",
              score: 0.876,
              excerpt: "Lifecycle hooks intercept tool calls.",
            },
            { slug: "hooks/guard", title: "Guard hooks" },
          ],
        })}
      />
    )

    const rows = screen.getAllByTestId("mcp-wiki-search-row")
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveAttribute("data-slug", "hooks/overview")
    expect(screen.getByText("Hooks overview")).toBeInTheDocument()
    expect(screen.getByText("Lifecycle hooks intercept tool calls.")).toBeInTheDocument()
    expect(screen.getByTestId("mcp-wiki-search-score")).toHaveTextContent("0.88")
  })

  it("renders an explicit empty result", () => {
    render(<WikiSearchCard part={part({ hits: [] })} />)
    expect(screen.getByText("No results")).toBeInTheDocument()
  })

  it("renders nothing for a non-hits output", () => {
    const { container } = render(<WikiSearchCard part={part({ result: [] })} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("clamps long hit lists behind the preview note and reveals on demand", () => {
    const hits = Array.from({ length: 205 }, (_, i) => ({
      slug: `p-${i}`,
      title: `page-${i}`,
    }))
    render(<WikiSearchCard part={part({ hits })} />)

    expect(screen.getAllByTestId("mcp-wiki-search-row")).toHaveLength(200)
    expect(screen.getByTestId("mcp-wiki-search-clamped")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("mcp-wiki-search-clamped-show-all"))

    expect(screen.getAllByTestId("mcp-wiki-search-row")).toHaveLength(205)
    expect(screen.queryByTestId("mcp-wiki-search-clamped")).not.toBeInTheDocument()
  })
})
