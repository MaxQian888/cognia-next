/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"

import { RagSearchCard } from "./rag-search-card"

function part(output: unknown): ToolUIPart {
  return {
    type: "tool-rag_search",
    toolCallId: "rag-call",
    state: "output-available",
    input: { query: "vector database" },
    output,
  } as unknown as ToolUIPart
}

describe("RagSearchCard", () => {
  it("renders a translated title, pluralized count, and responsive hit metadata", () => {
    render(
      <RagSearchCard
        part={part({
          hits: [
            {
              id: "chunk-1",
              sourceTitle: "Vector ADR",
              scope: "workspace",
              score: 0.923,
              content: "The native backend uses sqlite-vec.",
            },
            { id: "chunk-2", content: "Cloud backends use keyring credentials." },
          ],
        })}
      />
    )

    expect(screen.getByText("Knowledge search")).toBeInTheDocument()
    expect(screen.getByTestId("mcp-rag-search-card-badge")).toHaveTextContent("2 chunks")
    expect(screen.getByText("Vector ADR")).toBeInTheDocument()
    expect(screen.getByText("workspace")).toBeInTheDocument()
    expect(screen.getByTestId("mcp-rag-search-score")).toHaveTextContent("0.92")
    expect(screen.getByText("The native backend uses sqlite-vec.")).toBeInTheDocument()
  })

  it("uses the singular count and renders an explicit empty result", () => {
    const { rerender } = render(<RagSearchCard part={part({ hits: [{ id: "only" }] })} />)
    expect(screen.getByTestId("mcp-rag-search-card-badge")).toHaveTextContent("1 chunk")

    rerender(<RagSearchCard part={part({ hits: [] })} />)
    expect(screen.getByText("No matching knowledge found")).toBeInTheDocument()
  })

  it("omits invalid scores and unsupported output shapes", () => {
    const { rerender, container } = render(
      <RagSearchCard part={part({ hits: [{ id: "bad", score: Number.NaN }] })} />
    )
    expect(screen.queryByTestId("mcp-rag-search-score")).not.toBeInTheDocument()

    rerender(<RagSearchCard part={part({ result: [] })} />)
    expect(container).toBeEmptyDOMElement()
  })
})
