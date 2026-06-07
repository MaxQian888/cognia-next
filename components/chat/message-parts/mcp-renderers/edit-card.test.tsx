/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"

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
    expect(screen.getByTestId("mcp-edit-path")).toHaveTextContent("src/a.ts")
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
    expect(screen.getByTestId("mcp-edit-path")).toHaveTextContent("x.ts")
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
})
