/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"
import type { ToolUIPart } from "ai"

const openEditInWorkbenchReview = jest.fn()
jest.mock("@/lib/files/edit-review-bridge", () => ({
  canOfferWorkbenchReview: () => true,
  openEditInWorkbenchReview: (args: unknown) => openEditInWorkbenchReview(args),
}))

import { EditCard } from "./edit-card"

const part = (input?: unknown, output?: unknown): ToolUIPart =>
  ({
    type: "tool-edit",
    toolCallId: "call",
    state: "output-available",
    input,
    output,
  }) as unknown as ToolUIPart

describe("EditCard", () => {
  it("renders the path and a diff for a single edit payload", () => {
    render(
      <EditCard
        part={part(
          { file_path: "src/a.ts", old_string: "const x = 1", new_string: "const x = 2" },
          "Edited src/a.ts: 1 replacement."
        )}
      />
    )
    // The row above owns the file identity — the body carries only diffs.
    expect(screen.getByTestId("diff-preview")).toBeInTheDocument()
    expect(screen.getByTestId("mcp-edit-result")).toHaveTextContent("1 replacement")
  })

  it("renders one diff per edit for multi_edit payloads", () => {
    render(
      <EditCard
        part={part({
          file_path: "src/a.ts",
          edits: [
            { old_string: "a", new_string: "b" },
            { old_string: "c", new_string: "d" },
          ],
        })}
      />
    )
    expect(screen.getAllByTestId("diff-preview")).toHaveLength(2)
  })

  it("accepts the legacy `path` field and renders without an output", () => {
    render(<EditCard part={part({ path: "x.ts", old_string: "a", new_string: "b" })} />)
    expect(screen.getByTestId("diff-preview")).toBeInTheDocument()
    expect(screen.queryByTestId("mcp-edit-result")).not.toBeInTheDocument()
  })

  it("returns null without a path or without edits", () => {
    const { container: noPath } = render(
      <EditCard part={part({ old_string: "a", new_string: "b" })} />
    )
    expect(noPath).toBeEmptyDOMElement()
    const { container: noEdits } = render(<EditCard part={part({ file_path: "x.ts" })} />)
    expect(noEdits).toBeEmptyDOMElement()
  })

  it("clamps a many-edit payload behind a show-all note", () => {
    const edits = Array.from({ length: 25 }, (_, i) => ({
      old_string: `old${i}`,
      new_string: `new${i}`,
    }))
    render(<EditCard part={part({ file_path: "a.ts", edits })} />)
    expect(screen.getAllByTestId("diff-preview")).toHaveLength(20)
    expect(screen.getByTestId("mcp-edit-clamped")).toHaveTextContent("Showing the first 20 of 25")
    fireEvent.click(screen.getByTestId("mcp-edit-clamped-show-all"))
    expect(screen.getAllByTestId("diff-preview")).toHaveLength(25)
    expect(screen.queryByTestId("mcp-edit-clamped")).not.toBeInTheDocument()
  })
})
