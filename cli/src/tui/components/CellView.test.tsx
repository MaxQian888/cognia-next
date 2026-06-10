import React from "react"
import { render } from "@testing-library/react"

import { CellView } from "./CellView"
import type { Cell } from "../state/types"

function renderCell(cell: Cell) {
  return render(<CellView cell={cell} />).container.textContent ?? ""
}

describe("CellView", () => {
  it("renders a user cell", () => {
    expect(renderCell({ id: "1", kind: "user", text: "hello" })).toContain("hello")
  })

  it("renders an assistant cell as markdown", () => {
    expect(renderCell({ id: "1", kind: "assistant", raw: "# Heading" })).toContain("Heading")
  })

  it("renders a collapsed and expanded thinking cell", () => {
    expect(
      renderCell({ id: "1", kind: "thinking", text: "secret", collapsed: true })
    ).not.toContain("secret")
    expect(renderCell({ id: "1", kind: "thinking", text: "secret", collapsed: false })).toContain(
      "secret"
    )
  })

  it("renders a tool cell with a summary and diff", () => {
    const text = renderCell({
      id: "1",
      kind: "tool",
      callKey: "k",
      toolName: "edit",
      input: { file_path: "/a.ts", old_string: "x", new_string: "y" },
      status: "running",
      collapsed: true,
    })
    expect(text).toContain("edit")
    expect(text).toContain("/a.ts")
    expect(text).toContain("x")
    expect(text).toContain("y")
  })

  it("renders an expanded non-diff tool result", () => {
    const text = renderCell({
      id: "1",
      kind: "tool",
      callKey: "k",
      toolName: "bash",
      input: { command: "ls" },
      status: "done",
      result: "file.txt",
      collapsed: false,
    })
    expect(text).toContain("bash")
    expect(text).toContain("file.txt")
  })

  it("serializes object tool results when expanded", () => {
    const text = renderCell({
      id: "1",
      kind: "tool",
      callKey: "k",
      toolName: "bash",
      input: {},
      status: "done",
      result: { ok: true },
      collapsed: false,
    })
    expect(text).toContain("ok")
  })

  it("renders a todo cell with status markers", () => {
    const text = renderCell({
      id: "1",
      kind: "todo",
      todos: [
        { content: "done item", status: "completed" },
        { content: "doing item", status: "in_progress" },
        { content: "todo item", status: "pending" },
      ],
    })
    expect(text).toContain("done item")
    expect(text).toContain("doing item")
    expect(text).toContain("todo item")
  })

  it("renders error and notice cells", () => {
    expect(renderCell({ id: "1", kind: "error", message: "boom" })).toContain("boom")
    expect(renderCell({ id: "1", kind: "notice", message: "fyi" })).toContain("fyi")
  })
})
