/** @jest-environment node */
import { cellToTerminalBlock, TerminalBlockCache } from "./cell-terminal-block"
import type { Cell } from "../state/types"

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
    expect(block.plainText).toContain("A │ B")
    expect(block.rowCount).toBe(block.lines.length)
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
      toolName: "Read",
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
