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

  it("shows a diffstat in the edit tool header", () => {
    const text = renderCell({
      id: "1",
      kind: "tool",
      callKey: "k",
      toolName: "edit",
      input: { file_path: "/a.ts", old_string: "x", new_string: "y\nz" },
      status: "done",
      collapsed: true,
    })
    expect(text).toContain("+2")
    expect(text).toContain("-1")
  })

  it("shows a namespace badge and collapsed name for an mcp tool", () => {
    const text = renderCell({
      id: "1",
      kind: "tool",
      callKey: "k",
      toolName: "mcp__github__create_issue",
      input: {},
      status: "running",
      collapsed: true,
    })
    expect(text).toContain("[mcp]")
    expect(text).toContain("github:create_issue")
  })

  it("shows a result size hint on a collapsed non-diff tool card", () => {
    const text = renderCell({
      id: "1",
      kind: "tool",
      callKey: "k",
      toolName: "read",
      input: { file_path: "/a.ts" },
      status: "done",
      result: "a\nb\nc",
      collapsed: true,
    })
    expect(text).toContain("3 lines")
    // The body itself stays hidden while collapsed.
    expect(text).not.toContain("\nb\n")
  })

  it("shows a one-line error preview on a collapsed errored tool card", () => {
    const text = renderCell({
      id: "1",
      kind: "tool",
      callKey: "k",
      toolName: "bash",
      input: { command: "false" },
      status: "error",
      result: "Error: command failed\nmore detail",
      isError: true,
      collapsed: true,
    })
    expect(text).toContain("Error: command failed")
    // The full body stays hidden while collapsed.
    expect(text).not.toContain("more detail")
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

  it("summarizes the hidden tail when an expanded tool result overflows the cap", () => {
    const huge = "L\n".repeat(3000) // ~6000 chars, > the 4000 cap
    const text = renderCell({
      id: "1",
      kind: "tool",
      callKey: "k",
      toolName: "bash",
      input: { command: "cat big" },
      status: "done",
      result: huge,
      collapsed: false,
    })
    expect(text).toContain("more lines hidden")
  })

  it("does not show a hidden-lines note for a small result", () => {
    const text = renderCell({
      id: "1",
      kind: "tool",
      callKey: "k",
      toolName: "bash",
      input: { command: "ls" },
      status: "done",
      result: "short",
      collapsed: false,
    })
    expect(text).not.toContain("hidden")
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
