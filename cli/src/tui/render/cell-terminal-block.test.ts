/** @jest-environment node */
import {
  cellToTerminalBlock,
  markdownSpans,
  TerminalBlockCache,
  VERBATIM_RENDER_PREFS,
} from "./cell-terminal-block"
import { RENDER_DEFAULTS } from "../../config/schema"
import { stringWidth } from "../markdown/width"
import type { Cell, ToolCell } from "../state/types"

describe("cellToTerminalBlock", () => {
  it("keeps markdown structure and copy text available at narrow widths", () => {
    const cell: Cell = {
      id: "a1",
      kind: "assistant",
      raw: "# Heading\n\n- [x] done\n- [ ] todo\n\n> quote\n\n| A | B |\n| - | - |\n| 你 | 🚀 |",
    }
    const block = cellToTerminalBlock(cell, { width: 20, verbose: false })
    expect(block.plainText).toContain("# Heading")
    expect(block.plainText).toContain("☑ done")
    expect(block.plainText).toContain("│ quote")
    expect(block.plainText).toContain("│ A  │ B  │")
    expect(block.rowCount).toBe(block.lines.length)
  })

  // This renderer paints the DEFAULT (fullscreen, virtualized) layout, so an
  // unaligned table here is the table the user actually sees. It used to join
  // cells with a bare " │ " and rule the header with a code-unit count, which
  // meant no column lined up and a CJK header got a half-width rule.
  it("frames a table and aligns its columns in display width", () => {
    const cell: Cell = {
      id: "t1",
      kind: "assistant",
      raw: ["| Model | Note |", "| --- | --- |", "| 模型 | ok |", "| claude | fine |"].join("\n"),
    }
    const rows = cellToTerminalBlock(cell, { width: 80, verbose: false }).plainText.split("\n")
    const framed = rows.filter((row) => row.startsWith("╭") || row.startsWith("│"))
    expect(framed[0]).toBe("╭────────┬──────╮")
    expect(framed[1]).toBe("│ Model  │ Note │")
    // "模型" is 4 display columns, so it is padded by 4 to the 6-wide column and
    // the next edge still lands under the header's.
    expect(framed).toContain("│ 模型   │ ok   │")
    for (const row of framed) expect(row.length > 0).toBe(true)
  })

  it("truncates a table's columns to the terminal instead of wrapping them", () => {
    const cell: Cell = {
      id: "t2",
      kind: "assistant",
      raw: [
        "| Command | Description |",
        "| --- | --- |",
        "| /backend | switch the agent backend for this session |",
      ].join("\n"),
    }
    const block = cellToTerminalBlock(cell, { width: 28, verbose: false })
    const framed = block.plainText.split("\n").filter((row) => row.startsWith("│"))
    for (const row of framed) expect(row.length).toBeLessThanOrEqual(28)
    expect(block.plainText).toContain("…")
  })

  it("never drops a supported content part", () => {
    const parts: Cell[] = [
      {
        id: "sources",
        kind: "content-part",
        partId: "sources",
        part: { type: "sources", sources: [{ id: "s", title: "Ink", url: "https://ink.test" }] },
      },
      {
        id: "a2ui",
        kind: "content-part",
        partId: "a2ui",
        part: { type: "a2ui", surfaceId: "surface", source: "external", payload: {} },
      },
      {
        id: "custom",
        kind: "content-part",
        partId: "custom",
        part: { type: "custom", customType: "plugin.card", summary: "Fallback" },
      },
    ]
    for (const cell of parts) {
      expect(cellToTerminalBlock(cell, { width: 40, verbose: false }).plainText.trim()).not.toBe("")
    }
  })

  it("shows expanded tool output only in verbose mode", () => {
    const cell: Cell = {
      id: "t",
      kind: "tool",
      callKey: "t",
      toolName: "git_show",
      input: { path: "a.txt" },
      status: "done",
      result: "VISIBLE\nSECRET",
      collapsed: true,
    }
    const collapsed = cellToTerminalBlock(cell, { width: 80, verbose: false }).plainText
    expect(collapsed).toContain("↳ VISIBLE")
    expect(collapsed).not.toContain("SECRET")
    expect(cellToTerminalBlock(cell, { width: 80, verbose: true }).plainText).toContain("SECRET")
  })

  it("styles a tool header: status, disclosure, glyph, label and result chip", () => {
    const cell: Cell = {
      id: "t",
      kind: "tool",
      callKey: "t",
      toolName: "grep",
      input: { pattern: "foo" },
      status: "done",
      result: "a.ts:1:foo\nb.ts:2:foo",
      collapsed: true,
    }
    const block = cellToTerminalBlock(cell, { width: 120, verbose: false })
    const header = block.lines[0]
    expect(header.plain).toContain("✓")
    expect(header.plain).toContain("▸")
    expect(header.plain).toContain("⌕")
    expect(header.plain).toContain("Grep foo")
    expect(header.plain).toContain("2 matches")
    // The status glyph is green, the chip is dim: one row, several styles.
    expect(header.spans[0]).toMatchObject({ text: "✓ ", style: "success" })
    expect(header.spans.some((span) => span.style === "muted")).toBe(true)
    expect(header.spans.some((span) => span.bold)).toBe(true)
  })

  it("colours a diff's sign column and indents the body under a rule", () => {
    const cell: Cell = {
      id: "e",
      kind: "tool",
      callKey: "e",
      toolName: "edit",
      input: { file_path: "/a.ts", old_string: "before", new_string: "after" },
      status: "running",
      collapsed: true,
    }
    const block = cellToTerminalBlock(cell, { width: 120, verbose: false })
    expect(block.plainText).toContain("+1 -1")
    const added = block.lines.find((line) => line.plain.includes("+ after"))
    const removed = block.lines.find((line) => line.plain.includes("- before"))
    expect(added?.spans.some((span) => span.style === "success")).toBe(true)
    expect(removed?.spans.some((span) => span.style === "danger")).toBe(true)
    expect(added?.plain.startsWith("  │ ")).toBe(true)
  })

  it("puts a failure on its own detail row, not in the header chip", () => {
    const cell: Cell = {
      id: "f",
      kind: "tool",
      callKey: "f",
      toolName: "bash",
      input: { command: "false" },
      status: "error",
      isError: true,
      result: "Error: command failed\nstack frame",
      collapsed: true,
    }
    const block = cellToTerminalBlock(cell, { width: 120, verbose: false })
    expect(block.lines[0].plain).not.toContain("Error: command failed")
    expect(block.plainText).toContain("↳ Error: command failed")
    expect(block.plainText).not.toContain("stack frame")
  })

  it("frames a sub-agent dispatch as a delegated agent, not a tool card", () => {
    const cell: Cell = {
      id: "s",
      kind: "tool",
      callKey: "s",
      toolName: "task",
      input: { subagent_type: "reviewer", prompt: "review the diff" },
      status: "done",
      result: "looks good",
      collapsed: true,
    }
    const block = cellToTerminalBlock(cell, { width: 120, verbose: false })
    expect(block.lines[0].plain).toContain("◆ reviewer")
    expect(block.lines[0].plain).toContain("subagent · done")
    expect(block.plainText).toContain("review the diff")
    expect(block.plainText).toContain("↳ looks good")
  })

  it("tints markdown structure instead of painting a whole reply one colour", () => {
    const block = cellToTerminalBlock(
      { id: "a", kind: "assistant", raw: "# Title\n\nsee `code` and [docs](https://x.test)" },
      { width: 120, verbose: false }
    )
    const heading = block.lines.find((line) => line.plain.includes("Title"))
    expect(heading?.spans.every((span) => span.style === "accent")).toBe(true)
    const body = block.lines.find((line) => line.plain.includes("code"))
    expect(body?.spans.some((span) => span.style === "code")).toBe(true)
    expect(body?.spans.some((span) => span.style === "accent" && span.underline)).toBe(true)
  })

  it("honours the transcript render preferences the Ink cards already obeyed", () => {
    const cell: Cell = {
      id: "r",
      kind: "tool",
      callKey: "r",
      toolName: "read",
      input: { file_path: "demo.ts" },
      status: "done",
      collapsed: false,
      result: Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n"),
    }
    const numbered = cellToTerminalBlock(cell, {
      width: 80,
      verbose: false,
      prefs: { ...RENDER_DEFAULTS, toolResultMaxLines: 3 },
    })
    expect(numbered.plainText).toContain("1 │ line 1")
    expect(numbered.plainText).toContain("+9 more lines hidden")
    expect(numbered.plainText).not.toContain("line 12")

    const plain = cellToTerminalBlock(cell, {
      width: 80,
      verbose: false,
      prefs: { ...RENDER_DEFAULTS, fileLineNumbers: false },
    })
    expect(plain.plainText).toContain("line 1")
    expect(plain.plainText).not.toContain("1 │ line 1")
  })

  it("redirects an oversized result to the pager instead of flooding the viewport", () => {
    const cell: Cell = {
      id: "big",
      kind: "tool",
      callKey: "big",
      toolName: "bash",
      input: { command: "cat huge.log" },
      status: "done",
      collapsed: false,
      result: Array.from({ length: 400 }, (_, i) => `row ${i}`).join("\n"),
    }
    const block = cellToTerminalBlock(cell, { width: 80, verbose: false, prefs: RENDER_DEFAULTS })
    expect(block.plainText).toContain("400 lines total")
    expect(block.plainText).toContain("/expand")
    expect(block.rowCount).toBeLessThan(30)
  })

  it("renders verbatim for the pager: no cap, no gutter", () => {
    const cell: Cell = {
      id: "v",
      kind: "tool",
      callKey: "v",
      toolName: "read",
      input: { file_path: "demo.ts" },
      status: "done",
      collapsed: false,
      result: Array.from({ length: 300 }, (_, i) => `row ${i}`).join("\n"),
    }
    const block = cellToTerminalBlock(cell, {
      width: 80,
      verbose: true,
      prefs: VERBATIM_RENDER_PREFS,
    })
    expect(block.plainText).toContain("row 299")
    expect(block.plainText).not.toContain("/expand")
    expect(block.plainText).not.toContain("1 │ ")
  })

  it("keeps streaming and extended fence fallbacks copyable and safe", () => {
    const raw = [
      "Nested:",
      "- outer",
      "  - inner",
      "",
      "[docs](https://example.test) ![diagram](https://example.test/a.png)",
      "",
      "<script>not executed</script>",
      "",
      "```mermaid",
      "graph TD; A-->B",
      "```",
      "```math",
      "x^2 + y^2",
      "```",
      "```a2ui",
      '{"rootId":"root"}',
      "```",
      "unfinished **stream\u001b[2J",
    ].join("\n")
    for (const width of [20, 40, 80, 160]) {
      const block = cellToTerminalBlock(
        { id: `golden-${width}`, kind: "assistant", raw },
        { width, verbose: false }
      )
      expect(block.plainText).toContain("outer")
      expect(block.plainText).toContain("inner")
      expect(block.plainText).toContain("graph TD; A-->B")
      expect(block.plainText).toContain("x^2 + y^2")
      expect(block.plainText).toContain("rootId")
      expect(block.plainText).toContain("not executed")
      expect(block.plainText).not.toContain("\u001b")
      expect(block.lines.every((line) => line.plain.length === 0 || line.spans.length > 0)).toBe(
        true
      )
    }
  })
})

describe("TerminalBlockCache", () => {
  it("keys entries by id, width, theme, preferences, and revision", () => {
    const cache = new TerminalBlockCache()
    const build = jest.fn(() =>
      cellToTerminalBlock({ id: "n", kind: "notice", message: "x" }, { width: 40, verbose: false })
    )
    const key = { id: "n", width: 40, theme: "dark", preferences: "compact", revision: "x" }
    expect(cache.get(key, build)).toBe(cache.get(key, build))
    expect(build).toHaveBeenCalledTimes(1)
    expect(cache.stats()).toEqual({ hits: 1, misses: 1, size: 1, hitRate: 0.5 })
    cache.get({ ...key, width: 80 }, build)
    expect(build).toHaveBeenCalledTimes(2)
  })
})

describe("rich fullscreen Markdown", () => {
  it("exports styled document spans with link footnotes, rules, and unbounded nested blocks", () => {
    const raw =
      "#### Heading \u0060code\u0060\n\n> **bold** _italic_ [link](https://x.test)\n\n- item\n\n  continuation\n\n| [Header](./header) | B |\n| --- | --- |\n| [body](./body) | value |\n\n---\n\n~~~diff\n-old\n+new\n~~~"
    const spans = markdownSpans(raw, true)
    const text = spans.map((span) => span.text).join("")
    expect(text).toContain("[1] ./header")
    expect(text).toContain("[2] ./body")
    expect(text).toContain("─".repeat(24))
    expect(text).toContain("    continuation")
    expect(spans.some((span) => span.bold && span.text === "bold")).toBe(true)
    expect(spans.some((span) => span.italic && span.text === "italic")).toBe(true)
    expect(text).toContain("+new")
  })

  it("preserves nested blocks, image targets, and narrow table contents", () => {
    const raw =
      "- first\n\n  continued\n\n  > - [x] checked\n  >\n  > ~~~diff file.patch\n  > -old\n  > +new\n  > ~~~\n\n| A | B |\n| --- | --- |\n| alpha | beta |\n\n![map](./map.png)"
    const block = cellToTerminalBlock(
      { id: "rich", kind: "assistant", raw },
      { width: 80, verbose: false }
    )
    for (const part of [
      "continued",
      "☑ checked",
      "╭─ diff",
      "-old",
      "+new",
      "alpha",
      "beta",
      "[image: map] (./map.png)",
    ])
      expect(block.plainText).toContain(part)
    const narrow = cellToTerminalBlock(
      { id: "narrow", kind: "assistant", raw },
      { width: 10, verbose: false }
    )
    expect(narrow.plainText).toContain("A: alpha")
    expect(narrow.plainText).toContain("B: beta")
    expect(narrow.lines.every((line) => line.plain.length <= 10)).toBe(true)
  })

  it("keeps hard breaks and strips entity-encoded controls throughout streaming", () => {
    const raw = "one  \ntwo\n\n> ~~~diff\n> +new\n> ~~~\n\n&#27;[2J &#1114112;"
    for (let i = 0; i <= raw.length; i++) {
      const block = cellToTerminalBlock(
        { id: "stream", kind: "assistant", raw: raw.slice(0, i) },
        { width: 20, verbose: false }
      )
      expect(block.plainText).not.toContain("\u001b")
    }
    const block = cellToTerminalBlock(
      { id: "final", kind: "assistant", raw },
      { width: 20, verbose: false }
    )
    expect(block.plainText).toContain("one\ntwo")
    expect(block.plainText).toContain("�")
  })

  it("keeps wrapped tasks and quotes under their gutters in physical rows", () => {
    const block = cellToTerminalBlock(
      {
        id: "hang",
        kind: "assistant",
        raw: "- [x] abcdefghijklmnop\n\n  continuation\n\n> abcdefghijklmnop",
      },
      { width: 12, verbose: false }
    )
    expect(block.plainText).not.toContain("[x]")
    expect(block.plainText).toContain("  ☑ abcdefgh\n    ijklmnop")
    expect(block.plainText).toContain("│ abcdefghij\n│ klmnop")
    expect(block.lines[0].spans[0].style).toBe("success")
    expect(
      markdownSpans("> - task\n>\n> ~~~\n> code\n> ~~~")
        .map((span) => span.text)
        .join("")
    ).toContain("│   • task")
  })
})

describe("fullscreen tool readability", () => {
  const tool = (overrides: Partial<ToolCell> = {}): ToolCell => ({
    id: "readable",
    kind: "tool",
    callKey: "readable",
    toolName: "bash",
    input: { command: "pnpm test" },
    status: "done",
    collapsed: false,
    ...overrides,
  })

  it.each([20, 32, 80])(
    "bounds structured previews and retains readable action/output at width %s",
    (width) => {
      const cell = tool({
        result: { exit_code: 0, stdout: "passed\n" + "界".repeat(400), files: ["a.ts", "b.ts"] },
      })
      const block = cellToTerminalBlock(cell, { width, verbose: false })
      expect(block.plainText).toContain("Exit code:")
      expect(block.plainText).toContain("Stdout:")
      expect(block.plainText).not.toContain('"exit_code"')
      expect(block.plainText).toContain("/expand")
      expect(block.lines.every((line) => stringWidth(line.plain) <= width)).toBe(true)
      expect(block.rowCount).toBeLessThan(20)
      expect(
        block.lines
          .flatMap((line) => line.spans)
          .filter((span) => span.text.includes("pnpm test"))
          .every((span) => span.style === "plain")
      ).toBe(true)
      expect(
        block.lines
          .flatMap((line) => line.spans)
          .some((span) => span.text.includes("Exit code:") && span.style === "plain")
      ).toBe(true)
    }
  )

  it("preserves full source and object fields for the explicit verbatim pager", () => {
    const value = "x".repeat(500)
    const block = cellToTerminalBlock(tool({ result: { stdout: value, exit_code: 0 } }), {
      width: 20,
      verbose: true,
      prefs: VERBATIM_RENDER_PREFS,
    })
    expect(block.plainText).toContain('"stdout"')
    expect(block.plainText).toContain(value)
    expect(block.plainText).not.toContain("/expand")
  })

  it("keeps array text blocks readable and image bodies elided", () => {
    const block = cellToTerminalBlock(
      tool({
        result: {
          content: [
            { type: "text", text: "first\nsecond" },
            { type: "image", mimeType: "image/png", data: "A".repeat(2000) },
          ],
        },
      }),
      { width: 80, verbose: false }
    )
    expect(block.plainText).toContain("first")
    expect(block.plainText).toContain("second")
    expect(block.plainText).toContain("<image>")
    expect(block.plainText).not.toContain("A".repeat(100))
  })

  it("uses the same bounded body for delegated results and honors disabled gutters", () => {
    const block = cellToTerminalBlock(
      tool({ toolName: "task", input: { description: "review" }, result: { status: "complete" } }),
      {
        width: 32,
        verbose: true,
        prefs: { ...RENDER_DEFAULTS, fileLineNumbers: false, toolResultMaxLines: 0 },
      }
    )
    expect(block.plainText).toContain("Status: complete")
    expect(block.plainText).not.toContain("1 │")
  })

  it("keeps empty and unavailable results safe", () => {
    const empty = cellToTerminalBlock(tool({ result: "" }), { width: 32, verbose: true })
    expect(empty.plainText).not.toContain("/expand")
    const result = Object.defineProperty({}, "bad", {
      enumerable: true,
      get() {
        throw new Error("unavailable")
      },
    })
    const unavailable = cellToTerminalBlock(tool({ result }), { width: 80, verbose: true })
    expect(unavailable.plainText).toContain("[unavailable tool result]")
  })

  it("keeps completed command output at normal contrast", () => {
    const block = cellToTerminalBlock(tool({ result: "working tree clean", collapsed: true }), {
      width: 80,
      verbose: false,
    })
    expect(
      block.lines
        .flatMap((line) => line.spans)
        .some((span) => span.text.includes("working tree clean") && span.style === "plain")
    ).toBe(true)
  })
})

describe("fullscreen tool lifecycle boundaries", () => {
  const tool = (overrides: Partial<ToolCell>): ToolCell => ({
    id: "lifecycle",
    kind: "tool",
    callKey: "lifecycle",
    toolName: "bash",
    input: {},
    status: "done",
    collapsed: true,
    ...overrides,
  })
  it("retains namespace, title and cancellation when no result body exists", () => {
    const block = cellToTerminalBlock(
      tool({ toolName: "mcp__fs__read", displayTitle: "Inspect source", status: "cancelled" }),
      { width: 80, verbose: false }
    )
    expect(block.plainText).toContain("[mcp]")
    expect(block.plainText).toContain("Inspect source")
    expect(block.plainText).toContain("stopped")
    expect(block.plainText).not.toContain("▸")
  })
  it("does not invent previews for running, empty or user-cancelled output", () => {
    for (const cell of [
      tool({ status: "running", result: "partial" }),
      tool({ result: "" }),
      tool({ status: "cancelled", result: "Cancelled by user." }),
    ]) {
      const block = cellToTerminalBlock(cell, { width: 80, verbose: false })
      expect(block.plainText).not.toContain("↳")
      expect(block.plainText).not.toContain("Cancelled by user.")
    }
  })
  it("keeps cancelled delegated work distinct from expanded successful replies", () => {
    const block = cellToTerminalBlock(
      tool({ toolName: "task", status: "cancelled", result: "Cancelled by user." }),
      { width: 80, verbose: true }
    )
    expect(block.plainText).toContain("stopped")
    expect(block.plainText).not.toContain("▾")
  })
})
