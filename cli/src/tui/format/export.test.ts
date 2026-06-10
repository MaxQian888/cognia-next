import { exportExtension, formatTranscriptExport, normalizeExportFormat } from "./export"
import type { TranscriptEntry } from "../../agent/transcript"

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
