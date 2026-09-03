/** @jest-environment node */
import {
  buildTerminalBlock,
  terminalStringWidth,
  wrapTerminalSpans,
  wrapTerminalText,
} from "./terminal-block"

describe("TerminalBlock", () => {
  it.each([20, 40, 80, 160])("reports exact wrapped rows at %i columns", (width) => {
    const text = "x".repeat(width * 2 + 1)
    const block = buildTerminalBlock({ id: "b", text, width })
    expect(block.rowCount).toBe(3)
    expect(block.lines.every((line) => terminalStringWidth(line.plain) <= width)).toBe(true)
    expect(block.plainText).toBe(text)
  })

  it("counts CJK, emoji graphemes, and combining marks in terminal columns", () => {
    expect(terminalStringWidth("你好")).toBe(4)
    expect(terminalStringWidth("🚀")).toBe(2)
    expect(terminalStringWidth("👨‍👩‍👧‍👦")).toBe(2)
    expect(terminalStringWidth("e\u0301")).toBe(1)
    expect(wrapTerminalText("你好ab", 4)).toEqual(["你好", "ab"])
  })

  it("removes untrusted ANSI, OSC links, screen controls, and C0 bytes", () => {
    const hostile =
      "safe\u001b[31mred\u001b[0m\u001b]8;;https://evil.test\u0007link\u001b]8;;\u0007\u001b[2J\u0000end"
    const block = buildTerminalBlock({ id: "b", text: hostile, width: 80 })
    expect(block.lines.map((line) => line.plain).join("")).toBe("saferedlinkend")
    expect(JSON.stringify(block)).not.toContain("\u001b")
  })

  it("carries a style across a wrap and rejoins same-styled graphemes", () => {
    const lines = wrapTerminalSpans(
      [
        { text: "abc", style: "success", bold: true },
        { text: "de", style: "success", bold: true },
        { text: "fgh", style: "danger" },
      ],
      4
    )
    expect(lines.map((line) => line.plain)).toEqual(["abcd", "efgh"])
    // Row 1 is a single rejoined span, row 2 splits at the style change.
    expect(lines[0].spans).toEqual([{ text: "abcd", style: "success", bold: true }])
    expect(lines[1].spans).toEqual([
      { text: "e", style: "success", bold: true },
      { text: "fgh", style: "danger" },
    ])
  })

  it("breaks a row on a newline inside a span, blank rows included", () => {
    const lines = wrapTerminalSpans([{ text: "a\n\nb", style: "plain" }], 80)
    expect(lines.map((line) => line.plain)).toEqual(["a", "", "b"])
    expect(lines[1].spans).toEqual([])
  })

  it("counts the same rows for a styled run as for its plain text", () => {
    const width = 12
    const spans = [
      { text: "\u2713 ", style: "success" as const },
      { text: "Bash ", style: "plain" as const, bold: true },
      { text: "pnpm test --watch", style: "muted" as const },
    ]
    const styled = buildTerminalBlock({ id: "s", spans, width })
    const plain = buildTerminalBlock({
      id: "p",
      text: spans.map((span) => span.text).join(""),
      width,
    })
    expect(styled.rowCount).toBe(plain.rowCount)
    expect(styled.plainText).toBe(plain.plainText)
  })

  it("keeps stable metadata and an interaction target", () => {
    expect(
      buildTerminalBlock({ id: "file-1", text: "report", width: 40, target: "open:file-1" })
    ).toMatchObject({ id: "file-1", rowCount: 1, target: "open:file-1" })
  })
})
