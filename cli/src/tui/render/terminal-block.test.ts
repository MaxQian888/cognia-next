/** @jest-environment node */
import { buildTerminalBlock, terminalStringWidth, wrapTerminalText } from "./terminal-block"

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

  it("keeps stable metadata and an interaction target", () => {
    expect(
      buildTerminalBlock({ id: "file-1", text: "report", width: 40, target: "open:file-1" })
    ).toMatchObject({ id: "file-1", rowCount: 1, target: "open:file-1" })
  })
})
