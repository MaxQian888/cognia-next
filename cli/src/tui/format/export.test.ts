import {
  exportExtension,
  formatCellsAsMarkdown,
  formatTranscriptExport,
  normalizeExportFormat,
} from "./export"
import type { TranscriptEntry } from "../../agent/transcript"
import type { Cell } from "../state/types"

const entries: TranscriptEntry[] = [
  { ts: 1, role: "user", content: "  hello  " },
  { ts: 2, role: "assistant", content: "hi there" },
]

describe("normalizeExportFormat", () => {
  it.each([
    ["json", "json"],
    ["jsonl", "jsonl"],
    ["md", "markdown"],
    ["markdown", "markdown"],
    ["", "markdown"],
    ["MARKDOWN", "markdown"],
    ["bogus", "markdown"],
    [undefined, "markdown"],
  ] as const)("maps %p → %p", (raw, expected) => {
    expect(normalizeExportFormat(raw)).toBe(expected)
  })
})

describe("exportExtension", () => {
  it("maps markdown to md and leaves the rest", () => {
    expect(exportExtension("markdown")).toBe("md")
    expect(exportExtension("json")).toBe("json")
    expect(exportExtension("jsonl")).toBe("jsonl")
  })
})

describe("formatTranscriptExport", () => {
  it("renders jsonl as one record per line with a trailing newline", () => {
    const out = formatTranscriptExport(entries, "jsonl")
    expect(out).toBe(`${JSON.stringify(entries[0])}\n${JSON.stringify(entries[1])}\n`)
  })

  it("renders empty jsonl as the empty string", () => {
    expect(formatTranscriptExport([], "jsonl")).toBe("")
  })

  it("renders json as a pretty array", () => {
    expect(formatTranscriptExport(entries, "json")).toBe(JSON.stringify(entries, null, 2) + "\n")
  })

  it("renders markdown with role headings and trimmed content", () => {
    const md = formatTranscriptExport(entries, "markdown")
    expect(md).toContain("# Conversation export")
    expect(md).toContain("## User")
    expect(md).toContain("## Assistant")
    expect(md).toContain("hello")
    expect(md).not.toContain("  hello  ")
  })
})

describe("formatCellsAsMarkdown", () => {
  it("renders each cell kind under its own heading", () => {
    const cells: Cell[] = [
      { id: "1", kind: "user", text: "  do the thing  " },
      { id: "2", kind: "assistant", raw: "done" },
    ]
    expect(formatCellsAsMarkdown(cells)).toBe(
      "# Conversation\n\n## User\n\ndo the thing\n\n## Assistant\n\ndone\n"
    )
  })

  it("fences program output so a paste keeps its formatting", () => {
    const cells: Cell[] = [{ id: "1", kind: "bash", command: "ls", output: "a\nb", status: "done" }]
    expect(formatCellsAsMarkdown(cells)).toContain("### Shell\n\n```\nls\na\nb\n```")
  })

  it("covers tool, thinking, todo, plan and error cells", () => {
    const cells: Cell[] = [
      { id: "1", kind: "thinking", text: "hmm", collapsed: false },
      {
        id: "2",
        kind: "tool",
        callKey: "k",
        toolName: "Read",
        input: {},
        status: "done",
        result: "file body",
        collapsed: false,
      },
      { id: "3", kind: "todo", todos: [{ content: "step one", status: "pending" }] },
      { id: "4", kind: "plan", raw: "the plan" },
      { id: "5", kind: "error", message: "it broke" },
    ]
    const out = formatCellsAsMarkdown(cells)
    expect(out).toContain("### Thinking\n\nhmm")
    expect(out).toContain("### Tool")
    expect(out).toContain("file body")
    expect(out).toContain("### Todos\n\nstep one")
    expect(out).toContain("### Plan\n\nthe plan")
    expect(out).toContain("### Error\n\nit broke")
  })

  it("exports canonical commentary, content, and event cells", () => {
    const cells: Cell[] = [
      { id: "1", kind: "commentary", messageId: "m1", text: "checking", done: true },
      {
        id: "2",
        kind: "content-part",
        partId: "p1",
        part: { type: "custom", customType: "report", summary: "structured content" },
      },
      {
        id: "3",
        kind: "canonical-event",
        eventId: "e1",
        level: "warning",
        title: "Runtime warning",
        summary: "retrying",
      },
    ]

    const out = formatCellsAsMarkdown(cells)
    expect(out).toContain("### Commentary\n\nchecking")
    expect(out).toContain("### Content\n\nreport\nstructured content")
    expect(out).toContain("### Event\n\nRuntime warning: retrying")
  })

  it("drops notices — they are UI chatter, not conversation", () => {
    const cells: Cell[] = [
      { id: "1", kind: "notice", message: "Copied to the clipboard." },
      { id: "2", kind: "user", text: "hi" },
    ]
    const out = formatCellsAsMarkdown(cells)
    expect(out).not.toContain("Copied to the clipboard.")
    expect(out).toContain("## User\n\nhi")
  })

  it("skips a cell whose body is empty", () => {
    const cells: Cell[] = [
      { id: "1", kind: "user", text: "   " },
      { id: "2", kind: "assistant", raw: "kept" },
    ]
    expect(formatCellsAsMarkdown(cells)).toBe("# Conversation\n\n## Assistant\n\nkept\n")
  })

  it("returns an empty string when nothing is left to render", () => {
    expect(formatCellsAsMarkdown([])).toBe("")
    expect(formatCellsAsMarkdown([{ id: "1", kind: "notice", message: "x" }])).toBe("")
  })
})
