/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"

import { RuntimeQueryCard } from "./runtime-query-card"

function part(output: unknown): ToolUIPart {
  return {
    type: "tool-runtime_query",
    toolCallId: "rq-call",
    state: "output-available",
    input: { kind: "skill" },
    output,
  } as unknown as ToolUIPart
}

describe("RuntimeQueryCard", () => {
  it("renders entity rows with kind metadata", () => {
    render(
      <RuntimeQueryCard
        part={part({
          kind: "skill",
          entities: [
            { id: "sk-1", name: "tea-cli", description: "Analyze Tea data" },
            { id: "sk-2", name: "bytedcli" },
          ],
        })}
      />
    )

    const rows = screen.getAllByTestId("mcp-runtime-query-row")
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveAttribute("data-id", "sk-1")
    expect(rows[0]).toHaveAttribute("data-kind", "skill")
    expect(screen.getByText("tea-cli")).toBeInTheDocument()
    expect(screen.getByText("Analyze Tea data")).toBeInTheDocument()
    expect(screen.getByText("bytedcli")).toBeInTheDocument()
  })

  it("renders an explicit empty result", () => {
    render(<RuntimeQueryCard part={part({ kind: "skill", entities: [] })} />)
    expect(screen.getByText("No matching entries")).toBeInTheDocument()
  })

  it("renders nothing for a non-entity output", () => {
    const { container } = render(<RuntimeQueryCard part={part({ result: [] })} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("clamps long entity lists behind the preview note and reveals on demand", () => {
    const entities = Array.from({ length: 205 }, (_, i) => ({
      id: `e-${i}`,
      name: `entity-${i}`,
    }))
    render(<RuntimeQueryCard part={part({ kind: "skill", entities })} />)

    expect(screen.getAllByTestId("mcp-runtime-query-row")).toHaveLength(200)
    expect(screen.getByTestId("mcp-runtime-query-clamped")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("mcp-runtime-query-clamped-show-all"))

    expect(screen.getAllByTestId("mcp-runtime-query-row")).toHaveLength(205)
    expect(screen.queryByTestId("mcp-runtime-query-clamped")).not.toBeInTheDocument()
  })
})
