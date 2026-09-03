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
    const collapsed = renderCell({ id: "1", kind: "thinking", text: "secret", collapsed: true })
    expect(collapsed).not.toContain("secret")
    // The reasoning is marked with the ∴ glyph (Claude Code / OpenCode style).
    expect(collapsed).toContain("∴ thinking")
    expect(renderCell({ id: "1", kind: "thinking", text: "secret", collapsed: false })).toContain(
      "secret"
    )
  })

  it("renders expanded thinking content as markdown (list bullets survive)", () => {
    const text = renderCell({
      id: "1",
      kind: "thinking",
      text: "- first\n- second",
      collapsed: false,
    })
    expect(text).toContain("first")
    expect(text).toContain("second")
    expect(text).toContain("•") // markdown bullet, not the raw "-"
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
    // The header humanizes the machine name the way the web row does.
    expect(text).toContain("Edit")
    expect(text).toContain("/a.ts")
    expect(text).toContain("x")
    expect(text).toContain("y")
    // A diff renders whether or not the card is collapsed, so no caret promises
    // an expansion that would reveal nothing.
    expect(text).not.toContain("▸")
  })

  it("shows a protocol label in the header while the canonical name still drives the diff", () => {
    // An external agent supplies prose ("Edit the config") as the tool label.
    // The header shows it, but formatting must key off the canonical name — the
    // whole point of keeping the two fields apart.
    const text = renderCell({
      id: "1",
      kind: "tool",
      callKey: "k",
      toolName: "edit",
      displayTitle: "Edit the config",
      input: { file_path: "/a.ts", old_string: "x", new_string: "y" },
      status: "running",
      collapsed: true,
    })
    expect(text).toContain("Edit the config")
    expect(text).toContain("/a.ts")
    expect(text).toContain("x")
    expect(text).toContain("y")
  })

  it("shows a tool-specific result count (grep → matches) in the collapsed header", () => {
    const text = renderCell({
      id: "1",
      kind: "tool",
      callKey: "k",
      toolName: "grep",
      input: { pattern: "foo" },
      status: "done",
      collapsed: true,
      result: "a.ts:1:foo\nb.ts:2:foo\nc.ts:3:foo",
    })
    expect(text).toContain("3 matches")
  })

  it("shows an animated spinner glyph while a tool is running", () => {
    const { container } = render(
      <CellView
        cell={{
          id: "1",
          kind: "tool",
          callKey: "k",
          toolName: "bash",
          input: { command: "sleep 1" },
          status: "running",
          collapsed: true,
        }}
      />
    )
    // The ink-spinner mock renders a span marked data-ink="spinner".
    expect(container.querySelector('[data-ink="spinner"]')).not.toBeNull()
  })

  it("renders an image result as a placeholder (no base64 wall) on a plain terminal", () => {
    const prev = { ...process.env }
    delete process.env.TERM_PROGRAM
    delete process.env.KITTY_WINDOW_ID
    process.env.TERM = "xterm-256color"
    const bigB64 = "A".repeat(500)
    try {
      const text = renderCell({
        id: "1",
        kind: "tool",
        callKey: "k",
        toolName: "screenshot",
        input: {},
        status: "done",
        collapsed: false,
        result: { type: "image", data: bigB64, mimeType: "image/png" },
      })
      expect(text).toContain("🖼 image (image/png")
      // The base64 payload must not be dumped into the transcript.
      expect(text).not.toContain(bigB64)
    } finally {
      process.env = prev
    }
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
    // The namespace stays (it is the useful half in a terminal, and the badge
    // sits beside it) while the tool segment is humanized.
    expect(text).toContain("github:Create issue")
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

  it("shows a result preview when a completed tool supplied no useful input summary", () => {
    const text = renderCell({
      id: "1",
      kind: "tool",
      callKey: "k",
      toolName: "git_status",
      input: {},
      status: "done",
      result: "On branch main\nworking tree clean",
      collapsed: true,
    })
    expect(text).toContain("On branch main")
  })

  it("pairs a collapsed tool call with its result preview even when the call has a summary", () => {
    const text = renderCell({
      id: "1",
      kind: "tool",
      callKey: "k",
      toolName: "bash",
      input: { command: "pwd" },
      status: "done",
      result: "/workspace\n",
      collapsed: true,
    })
    expect(text).toContain("pwd")
    expect(text).toContain("↳ /workspace")
  })

  it("makes a parallel subagent batch and a cancelled dispatch explicit", () => {
    const batch = renderCell({
      id: "1",
      kind: "tool",
      callKey: "batch",
      toolName: "dispatch_agent",
      input: {
        dispatches: [
          { subagentId: "frontend", prompt: "review UI" },
          { subagentId: "backend", prompt: "review runtime" },
        ],
      },
      status: "running",
      collapsed: true,
    })
    expect(batch).toContain("2 agents")
    expect(batch).toContain("parallel batch · 2 agents · running")

    const cancelled = renderCell({
      id: "2",
      kind: "tool",
      callKey: "cancelled",
      toolName: "dispatch_agent",
      input: { subagentId: "reviewer", prompt: "review" },
      status: "cancelled",
      result: "Cancelled by user.",
      collapsed: true,
    })
    expect(cancelled).toContain("○")
    expect(cancelled).toContain("stopped")
    expect(cancelled).not.toContain("Cancelled by user.")
    expect(cancelled).not.toContain("expand")
  })

  it("renders a generic cancelled tool as one quiet terminal row", () => {
    const cancelled = renderCell({
      id: "1",
      kind: "tool",
      callKey: "cancelled",
      toolName: "mcp__cognia_tools__dispatch_agent",
      displayTitle: "dispatch_agent",
      input: {},
      status: "cancelled",
      result: "Cancelled by user.",
      collapsed: true,
    })
    expect(cancelled).toContain("○")
    expect(cancelled).toContain("stopped")
    expect(cancelled).not.toContain("↳ Cancelled by user.")
    expect(cancelled).not.toContain("expand")
  })

  it("explains terminal tool events that supplied no result details", () => {
    const done = renderCell({
      id: "1",
      kind: "tool",
      callKey: "done",
      toolName: "read",
      input: {},
      status: "done",
      collapsed: true,
    })
    const failed = renderCell({
      id: "2",
      kind: "tool",
      callKey: "failed",
      toolName: "git_log",
      input: {},
      status: "error",
      isError: true,
      collapsed: true,
    })
    expect(done).toContain("completed · no details")
    expect(failed).toContain("failed · no error details")
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
    expect(text).toContain("Bash")
    expect(text).toContain("file.txt")
  })

  it("summarizes the hidden tail when an expanded result overflows the line cap", () => {
    // ~60 lines: over the 40-line default cap but under the 200-line pager
    // threshold, so it renders inline with a hidden-tail note.
    const overCap = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n")
    const text = renderCell({
      id: "1",
      kind: "tool",
      callKey: "k",
      toolName: "bash",
      input: { command: "cat mid" },
      status: "done",
      result: overCap,
      collapsed: false,
    })
    expect(text).toContain("more lines hidden")
  })

  it("redirects a very large result to the pager instead of flooding inline", () => {
    const huge = Array.from({ length: 3000 }, (_, i) => `L${i}`).join("\n")
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
    expect(text).toContain("open full output")
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

  it("line-numbers an expanded file (read) result", () => {
    const text = renderCell({
      id: "1",
      kind: "tool",
      callKey: "k",
      toolName: "read",
      input: { file_path: "/x/foo.ts" },
      status: "done",
      result: "const x = 1\nconst y = 2",
      collapsed: false,
    })
    // 1-based gutter from the line-numbers render pref (default on).
    expect(text).toContain("1 │")
    expect(text).toContain("2 │")
  })

  it("prints a bucket glyph so a read, a search and a shell-out differ at a glance", () => {
    const base = {
      id: "1",
      kind: "tool" as const,
      callKey: "k",
      status: "done" as const,
      collapsed: true,
    }
    const read = renderCell({ ...base, toolName: "read", input: { file_path: "/a.ts" } })
    const grep = renderCell({ ...base, toolName: "grep", input: { pattern: "foo" } })
    const bash = renderCell({ ...base, toolName: "bash", input: { command: "ls" } })
    expect(read).toContain("▤")
    expect(grep).toContain("⌕")
    expect(bash).toContain("»")
  })

  it("shows a caret only when collapsing actually hides a body", () => {
    const withOutput = renderCell({
      id: "1",
      kind: "tool",
      callKey: "k",
      toolName: "read",
      input: { file_path: "/a.ts" },
      status: "done",
      result: "contents",
      collapsed: true,
    })
    const withoutOutput = renderCell({
      id: "2",
      kind: "tool",
      callKey: "k",
      toolName: "read",
      input: { file_path: "/a.ts" },
      status: "running",
      collapsed: true,
    })
    expect(withOutput).toContain("▸")
    expect(withoutOutput).not.toContain("▸")
    const expanded = renderCell({
      id: "3",
      kind: "tool",
      callKey: "k",
      toolName: "read",
      input: { file_path: "/a.ts" },
      status: "done",
      result: "contents",
      collapsed: false,
    })
    expect(expanded).toContain("▾")
  })

  it("counts a context tool's result instead of echoing the file's first line", () => {
    const read = renderCell({
      id: "1",
      kind: "tool",
      callKey: "k",
      toolName: "read",
      input: { file_path: "/a.ts" },
      status: "done",
      result: "first line\nsecond line",
      collapsed: true,
    })
    expect(read).toContain("2 lines")
    expect(read).not.toContain("first line")
    // A shell command's output IS the answer, so it keeps its preview row.
    const bash = renderCell({
      id: "2",
      kind: "tool",
      callKey: "k",
      toolName: "bash",
      input: { command: "pwd" },
      status: "done",
      result: "/workspace",
      collapsed: true,
    })
    expect(bash).toContain("↳ /workspace")
  })

  it("keeps a failed call's message on the detail line, not in the header chip", () => {
    const text = renderCell({
      id: "1",
      kind: "tool",
      callKey: "k",
      toolName: "bash",
      input: { command: "false" },
      status: "error",
      isError: true,
      result: "Error: command failed\nmore detail",
      collapsed: true,
    })
    expect(text).toContain("↳ Error: command failed")
    // The header carries the command, the failure gets its own full-width row.
    expect(text.split("↳")[0]).not.toContain("Error: command failed")
  })

  it("marks a collapsed tool with output as expandable, without repeating the command", () => {
    const text = renderCell({
      id: "1",
      kind: "tool",
      callKey: "k",
      toolName: "read",
      input: { file_path: "/x/foo.ts" },
      status: "done",
      result: "const x = 1",
      collapsed: true,
    })
    // The caret is the affordance. `/inspect` is advertised once in the footer
    // hint (`Footer.HINT_TEXT`), not on every settled row.
    expect(text).toContain("▸")
    expect(text).not.toContain("/inspect")
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

  it("renders a sub-agent dispatch as a framed agent unit, not a plain tool card", () => {
    const text = renderCell({
      id: "1",
      kind: "tool",
      callKey: "k",
      toolName: "task",
      input: { subagent_type: "reviewer", description: "review the diff" },
      status: "running",
      collapsed: true,
    })
    expect(text).toContain("◆ reviewer")
    expect(text).toContain("subagent")
    expect(text).toContain("running")
    expect(text).toContain("review the diff")
  })

  it("shows the sub-agent reply when expanded and a result size hint when collapsed", () => {
    const expanded = renderCell({
      id: "1",
      kind: "tool",
      callKey: "k",
      toolName: "dispatch_agent",
      input: { subagent_type: "scout", prompt: "find files" },
      status: "done",
      result: "found 3 files",
      collapsed: false,
    })
    expect(expanded).toContain("◆ scout")
    expect(expanded).toContain("done")
    expect(expanded).toContain("found 3 files")

    const collapsed = renderCell({
      id: "1",
      kind: "tool",
      callKey: "k",
      toolName: "dispatch_agent",
      input: { subagent_type: "scout" },
      status: "done",
      result: "a\nb\nc",
      collapsed: true,
    })
    expect(collapsed).toContain("3 lines")
    expect(collapsed).not.toContain("\nb\n")
  })

  it("previews a failed sub-agent dispatch without expanding", () => {
    const text = renderCell({
      id: "1",
      kind: "tool",
      callKey: "k",
      toolName: "task",
      input: { subagent_type: "reviewer" },
      status: "error",
      result: "rejected: max depth\ndetail",
      isError: true,
      collapsed: true,
    })
    expect(text).toContain("failed")
    expect(text).toContain("rejected: max depth")
    expect(text).not.toContain("detail")
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

  it("renders an interrupted turn as a deliberate quiet boundary", () => {
    const text = renderCell({
      id: "1",
      kind: "notice",
      message: "Turn stopped by user.",
      tone: "interrupted",
    } as Cell)
    expect(text).toContain("──")
    expect(text).toContain("Turn stopped")
    expect(text).not.toContain("•")
  })

  it("renders a running bash cell with the kill/background hint", () => {
    const text = renderCell({
      id: "1",
      kind: "bash",
      command: "npm run dev",
      output: "listening",
      status: "running",
    })
    expect(text).toContain("npm run dev")
    expect(text).toContain("Ctrl+C kill")
    expect(text).toContain("Ctrl+B background")
  })

  it("labels a backgrounded bash cell, swapping the kill hint for /bashes", () => {
    const text = renderCell({
      id: "1",
      kind: "bash",
      command: "npm run dev",
      output: "",
      status: "running",
      background: true,
    })
    expect(text).toContain("(background)")
    expect(text).not.toContain("Ctrl+C kill")
    expect(text).toContain("/bashes")
  })

  it("shows no hint once a bash cell has settled", () => {
    const text = renderCell({
      id: "1",
      kind: "bash",
      command: "ls",
      output: "a\nb",
      status: "done",
      exitCode: 0,
    })
    expect(text).not.toContain("Ctrl+C kill")
  })

  describe("clickable file paths (OSC-8)", () => {
    const ORIG = { ...process.env }
    afterEach(() => {
      process.env = { ...ORIG }
    })

    it("wraps a read tool's path in a vscode://file link inside a VS Code terminal", () => {
      process.env.FORCE_HYPERLINK = "1"
      process.env.TERM_PROGRAM = "vscode"
      const text = renderCell({
        id: "1",
        kind: "tool",
        callKey: "k",
        toolName: "read",
        input: { file_path: "/repo/a.ts", offset: 12 },
        status: "done",
        collapsed: true,
      } as Cell)
      expect(text).toContain("vscode://file/repo/a.ts:12")
      expect(text).toContain("/repo/a.ts") // visible label unchanged
    })

    it("uses a file:// link outside a VS Code terminal", () => {
      process.env.FORCE_HYPERLINK = "1"
      delete process.env.TERM_PROGRAM
      const text = renderCell({
        id: "1",
        kind: "tool",
        callKey: "k",
        toolName: "read",
        input: { file_path: "/repo/a.ts" },
        status: "done",
        collapsed: true,
      } as Cell)
      // The exact file:// form is platform-dependent (drive-resolved on Windows);
      // assert it is an OSC-8 file link wrapping the visible path.
      expect(text).toContain("]8;;file://")
      expect(text).toContain("a.ts")
    })

    it("leaves the path plain when the terminal lacks hyperlink support", () => {
      process.env.FORCE_HYPERLINK = "0"
      const text = renderCell({
        id: "1",
        kind: "tool",
        callKey: "k",
        toolName: "read",
        input: { file_path: "/repo/a.ts" },
        status: "done",
        collapsed: true,
      } as Cell)
      expect(text).toContain("/repo/a.ts")
      expect(text).not.toContain("file://")
      expect(text).not.toContain("]8;;")
    })
  })

  it("renders source metadata and emits only safe OSC-8 links", () => {
    const previous = process.env.FORCE_HYPERLINK
    process.env.FORCE_HYPERLINK = "1"
    try {
      const safe = renderCell({
        id: "sources",
        kind: "content-part",
        partId: "sources",
        part: {
          type: "sources",
          sources: [
            {
              id: "ink",
              title: "Ink docs",
              url: "https://example.test/ink",
              score: 0.91,
              snippet: "Terminal renderer",
            },
          ],
        },
      })
      expect(safe).toContain("Ink docs")
      expect(safe).toContain("91%")
      expect(safe).toContain("\u001b]8;;https://example.test/ink")

      const unsafe = renderCell({
        id: "unsafe",
        kind: "content-part",
        partId: "unsafe",
        part: {
          type: "sources",
          sources: [{ id: "bad", title: "Unsafe", url: "javascript:alert(1)" }],
        },
      })
      expect(unsafe).not.toContain("\u001b]8;;javascript:")
    } finally {
      if (previous === undefined) delete process.env.FORCE_HYPERLINK
      else process.env.FORCE_HYPERLINK = previous
    }
  })

  it("renders a plan cell as a compact reference card (full body lives in the approval overlay / /plan)", () => {
    const text = renderCell({ id: "1", kind: "plan", raw: "# Approach\n- step one\n- step two" })
    expect(text).toContain("Plan ready for review")
    expect(text).toContain("2 steps")
    expect(text).toContain("Approach")
    expect(text).toContain("full text via /plan")
    // The full plan body is no longer duplicated in the transcript — it scrolls
    // inside the approval overlay instead.
    expect(text).not.toContain("step one")
  })
})
