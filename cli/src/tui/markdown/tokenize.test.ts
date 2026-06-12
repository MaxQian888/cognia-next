/**
 * @jest-environment node
 */
import {
  blocksToLines,
  inlineToSpans,
  orderedMarker,
  toAlpha,
  toRoman,
  tokenizeMarkdown,
} from "./tokenize"
import type { MdLine, MdSpan } from "./types"

type InlineTokens = Parameters<typeof inlineToSpans>[0]
type BlockTokens = Parameters<typeof blocksToLines>[0]

function spansOf(line: MdLine | undefined): MdSpan[] {
  return line && "spans" in line ? line.spans : []
}

describe("tokenizeMarkdown", () => {
  it("returns [] for empty input", () => {
    expect(tokenizeMarkdown("")).toEqual([])
  })

  it("parses heading level and text", () => {
    const lines = tokenizeMarkdown("### Title")
    expect(lines[0]).toMatchObject({ kind: "heading", level: 3 })
    expect(spansOf(lines[0])[0].text).toBe("Title")
  })

  it("parses a GFM table into a table line with header, rows and alignment", () => {
    const src = ["| Name | Age |", "| :--- | ---: |", "| Ann | 30 |", "| Bob | 25 |"].join("\n")
    const lines = tokenizeMarkdown(src)
    const table = lines.find((l) => l.kind === "table")
    expect(table).toBeDefined()
    if (!table || table.kind !== "table") throw new Error("no table")
    expect(table.header.map((cell) => cell.map((s) => s.text).join(""))).toEqual(["Name", "Age"])
    expect(table.rows).toHaveLength(2)
    expect(table.rows[0].map((cell) => cell.map((s) => s.text).join(""))).toEqual(["Ann", "30"])
    expect(table.align).toEqual(["left", "right"])
  })

  it("parses inline emphasis, code, strikethrough and links", () => {
    const lines = tokenizeMarkdown("a **b** _c_ `d` ~~e~~ [f](http://x)")
    const spans = spansOf(lines[0])
    expect(spans.find((s) => s.text === "b")).toMatchObject({ bold: true })
    expect(spans.find((s) => s.text === "c")).toMatchObject({ italic: true })
    expect(spans.find((s) => s.text === "d")).toMatchObject({ code: true })
    expect(spans.find((s) => s.text === "e")).toMatchObject({ strike: true })
    expect(spans.find((s) => s.text === "f")).toMatchObject({ link: "http://x" })
  })

  it("splits a fenced code block into per-line code lines with the language", () => {
    const lines = tokenizeMarkdown("```ts\nconst x = 1\nconst y = 2\n```")
    const code = lines.filter((l) => l.kind === "code")
    expect(code).toHaveLength(2)
    expect(code[0]).toMatchObject({ kind: "code", lang: "ts", text: "const x = 1" })
  })

  it("flags the first and last lines of a fenced code block for framing", () => {
    const code = tokenizeMarkdown("```ts\na\nb\nc\n```").filter((l) => l.kind === "code") as Array<{
      first?: boolean
      last?: boolean
    }>
    expect(code).toHaveLength(3)
    expect(code[0]).toMatchObject({ first: true })
    expect(code[0].last).toBeUndefined()
    expect(code[1].first).toBeUndefined()
    expect(code[1].last).toBeUndefined()
    expect(code[2]).toMatchObject({ last: true })
    expect(code[2].first).toBeUndefined()
  })

  it("renders blockquotes", () => {
    const lines = tokenizeMarkdown("> quoted text")
    expect(lines.some((l) => l.kind === "blockquote")).toBe(true)
  })

  it("stamps every code line with the block's widest display width", () => {
    // "const yy = 22" is 13 columns and the longest line; both lines carry it.
    const code = tokenizeMarkdown("```ts\nx\nconst yy = 22\n```").filter(
      (l) => l.kind === "code"
    ) as Array<{ width?: number }>
    expect(code).toHaveLength(2)
    expect(code[0].width).toBe(13)
    expect(code[1].width).toBe(13)
  })

  it("counts CJK code lines as double-width when sizing the block", () => {
    // "模型" is 4 display columns even though it is 2 code units.
    const code = tokenizeMarkdown("```\n模型\n```").filter((l) => l.kind === "code") as Array<{
      width?: number
    }>
    expect(code[0].width).toBe(4)
  })

  it("assigns depth 1 to a top-level quote and 2 to a nested quote", () => {
    const lines = tokenizeMarkdown("> outer\n>\n> > inner") as Array<{
      kind: string
      depth?: number
      spans?: Array<{ text: string }>
    }>
    const quotes = lines.filter((l) => l.kind === "blockquote")
    const outer = quotes.find((q) => (q.spans ?? []).some((s) => s.text.includes("outer")))
    const inner = quotes.find((q) => (q.spans ?? []).some((s) => s.text.includes("inner")))
    expect(outer?.depth).toBe(1)
    expect(inner?.depth).toBe(2)
  })

  it("renders unordered and ordered lists with markers", () => {
    const ul = tokenizeMarkdown("- one\n- two")
    const ulItems = ul.filter((l) => l.kind === "listitem")
    expect(ulItems).toHaveLength(2)
    expect(ulItems[0]).toMatchObject({ ordered: false, marker: "•" })

    const ol = tokenizeMarkdown("1. first\n2. second")
    const olItems = ol.filter((l) => l.kind === "listitem")
    expect(olItems[0]).toMatchObject({ ordered: true, marker: "1." })
    expect(olItems[1]).toMatchObject({ marker: "2." })
  })

  it("marks GFM task-list items with their checked state", () => {
    const lines = tokenizeMarkdown("- [x] done\n- [ ] todo\n- plain")
    const items = lines.filter((l) => l.kind === "listitem") as Array<{
      checked?: boolean
      spans: Array<{ text: string }>
    }>
    expect(items).toHaveLength(3)
    expect(items[0].checked).toBe(true)
    expect(items[0].spans.map((s) => s.text).join("")).toBe("done")
    expect(items[1].checked).toBe(false)
    // A non-task bullet carries no `checked` flag.
    expect(items[2].checked).toBeUndefined()
  })

  it("indents nested lists by depth", () => {
    const lines = tokenizeMarkdown("- top\n  - nested")
    const items = lines.filter((l) => l.kind === "listitem") as Array<{ depth: number }>
    expect(items.some((i) => i.depth === 1)).toBe(true)
  })

  it("renders a horizontal rule", () => {
    const lines = tokenizeMarkdown("text\n\n---\n\nmore")
    expect(lines.some((l) => l.kind === "rule")).toBe(true)
  })

  it("tolerates an unterminated streaming code fence without throwing", () => {
    expect(() => tokenizeMarkdown("```js\nconst half = ")).not.toThrow()
    const lines = tokenizeMarkdown("```js\nconst half = ")
    expect(lines.length).toBeGreaterThan(0)
  })

  it("emits blank lines for paragraph spacing", () => {
    const lines = tokenizeMarkdown("a\n\nb")
    expect(lines.some((l) => l.kind === "blank")).toBe(true)
  })

  it("collapses multiple blank lines into a single blank line", () => {
    const lines = tokenizeMarkdown("a\n\n\n\nb")
    const blanks = lines.filter((l) => l.kind === "blank")
    expect(blanks).toHaveLength(1)
  })

  it("drops a trailing blank line at the end of the output", () => {
    const lines = tokenizeMarkdown("a\n\n")
    expect(lines[lines.length - 1]?.kind).not.toBe("blank")
  })

  it("turns a hard line break into a space span", () => {
    const lines = tokenizeMarkdown("a  \nb")
    const spans = spansOf(lines[0])
    expect(spans.some((s) => s.text === " ")).toBe(true)
  })

  it("decodes common HTML entities in prose so the terminal shows real characters", () => {
    const lines = tokenizeMarkdown("it&#39;s a &quot;test&quot; with &amp; &lt; &gt;")
    const text = spansOf(lines[0])
      .map((s) => s.text)
      .join("")
    expect(text).toBe('it\'s a "test" with & < >')
  })

  it("decodes decimal and hexadecimal numeric entities", () => {
    const lines = tokenizeMarkdown("&#65; &#x42;")
    const text = spansOf(lines[0])
      .map((s) => s.text)
      .join("")
    expect(text).toBe("A B")
  })

  it("leaves HTML entities untouched inside inline code spans", () => {
    const lines = tokenizeMarkdown("`&#39;`")
    const spans = spansOf(lines[0])
    expect(spans).toHaveLength(1)
    // marked escapes the `&` in inline code; our decoder restores the literal.
    expect(spans[0]).toMatchObject({ text: "&#39;", code: true })
  })

  it("carries nested bold+italic emphasis on a span", () => {
    const lines = tokenizeMarkdown("**_x_**")
    const spans = spansOf(lines[0])
    expect(spans.find((s) => s.text === "x")).toMatchObject({ bold: true, italic: true })
  })

  it("honours an ordered list start offset", () => {
    const lines = tokenizeMarkdown("3. third\n4. fourth")
    const items = lines.filter((l) => l.kind === "listitem") as Array<{ marker: string }>
    expect(items[0].marker).toBe("3.")
    expect(items[1].marker).toBe("4.")
  })

  it("cycles the ordered-list numbering scheme by depth (1. → a. → i.)", () => {
    const src = "1. top\n   1. mid-a\n   2. mid-b\n      1. deep-i\n      2. deep-ii"
    const items = tokenizeMarkdown(src).filter((l) => l.kind === "listitem") as Array<{
      marker: string
      depth: number
    }>
    const at = (d: number) => items.filter((i) => i.depth === d).map((i) => i.marker)
    expect(at(0)).toEqual(["1."])
    expect(at(1)).toEqual(["a.", "b."])
    expect(at(2)).toEqual(["i.", "ii."])
  })

  it("falls back to plain text for an unknown block type (raw HTML)", () => {
    const lines = tokenizeMarkdown("<div>raw</div>")
    expect(lines.some((l) => l.kind === "paragraph")).toBe(true)
  })

  it("renders a list item whose only child is a nested list", () => {
    const lines = tokenizeMarkdown("- - x")
    const items = lines.filter((l) => l.kind === "listitem")
    // The outer item (no own text) plus the nested item.
    expect(items.length).toBeGreaterThanOrEqual(2)
    expect(items.some((l) => (l as { depth: number }).depth === 1)).toBe(true)
  })

  it("degrades to plain paragraphs when the lexer throws", () => {
    jest.isolateModules(() => {
      jest.doMock("marked", () => ({
        lexer: () => {
          throw new Error("boom")
        },
      }))
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- isolateModules needs a sync re-require under the mock
      const { tokenizeMarkdown: tk } = require("./tokenize") as typeof import("./tokenize")
      expect(tk("solo")).toEqual([{ kind: "paragraph", spans: [{ text: "solo" }] }])
    })
    jest.dontMock("marked")
  })
})

// Direct helper tests for the defensive fallbacks that partial mid-stream tokens
// (or sparse synthetic trees) exercise but a well-formed markdown string won't.
describe("inlineToSpans (defensive)", () => {
  it("returns [] for undefined tokens", () => {
    expect(inlineToSpans(undefined)).toEqual([])
  })

  it("uses href as link text when no label is present", () => {
    expect(inlineToSpans([{ type: "link", href: "u" }] as InlineTokens)).toEqual([
      { text: "u", link: "u" },
    ])
  })

  it("applies carried emphasis flags to a link label", () => {
    expect(
      inlineToSpans([{ type: "link", text: "t", href: "u" }] as InlineTokens, { bold: true })
    ).toEqual([{ text: "t", link: "u", bold: true }])
  })

  it("falls back to empty text for a text token missing text and raw", () => {
    expect(inlineToSpans([{ type: "text" }] as InlineTokens)).toEqual([{ text: "" }])
  })
})

describe("ordered-marker helpers", () => {
  it("toAlpha is bijective base-26", () => {
    expect(toAlpha(1)).toBe("a")
    expect(toAlpha(26)).toBe("z")
    expect(toAlpha(27)).toBe("aa")
    expect(toAlpha(0)).toBe("a") // clamped
  })

  it("toRoman builds lowercase numerals", () => {
    expect(toRoman(1)).toBe("i")
    expect(toRoman(4)).toBe("iv")
    expect(toRoman(9)).toBe("ix")
    expect(toRoman(14)).toBe("xiv")
    expect(toRoman(0)).toBe("i") // clamped
  })

  it("orderedMarker switches scheme by depth", () => {
    expect(orderedMarker(2, 0)).toBe("2.")
    expect(orderedMarker(2, 1)).toBe("b.")
    expect(orderedMarker(2, 5)).toBe("ii.")
  })
})

describe("blocksToLines (defensive)", () => {
  it("defaults heading depth to 1", () => {
    expect(blocksToLines([{ type: "heading", tokens: [] }] as BlockTokens)[0]).toMatchObject({
      kind: "heading",
      level: 1,
    })
  })

  it("handles a code token with no language or text", () => {
    expect(blocksToLines([{ type: "code" }] as BlockTokens)[0]).toEqual({
      kind: "code",
      lang: undefined,
      text: "",
      width: 0,
      first: true,
      last: true,
    })
  })

  it("handles a blockquote whose inner line has no spans", () => {
    const lines = blocksToLines([{ type: "blockquote", tokens: [{ type: "hr" }] }] as BlockTokens)
    expect(lines[0]).toEqual({ kind: "blockquote", depth: 1, spans: [] })
  })

  it("handles a list with no items and a non-numeric start", () => {
    expect(blocksToLines([{ type: "list", ordered: true, start: "" }] as BlockTokens)).toEqual([])
  })

  it("falls back to item.text for an item with no inline blocks", () => {
    const lines = blocksToLines([{ type: "list", items: [{ text: "bare" }] }] as BlockTokens)
    expect(lines[0]).toMatchObject({ kind: "listitem", spans: [{ text: "bare" }] })
  })

  it("yields an empty-span item when item.text is also missing", () => {
    const lines = blocksToLines([{ type: "list", items: [{}] }] as BlockTokens)
    expect(lines[0]).toMatchObject({ kind: "listitem", spans: [] })
  })

  it("builds a table line from cells without inline tokens (plain-text fallback)", () => {
    const lines = blocksToLines([
      { type: "table", header: [{ text: "H" }], rows: [[{ text: "R" }]], align: ["center"] },
    ] as BlockTokens)
    expect(lines[0]).toEqual({
      kind: "table",
      header: [[{ text: "H" }]],
      rows: [[[{ text: "R" }]]],
      align: ["center"],
    })
  })

  it("tolerates a table token with no header, rows, or align", () => {
    const lines = blocksToLines([{ type: "table" }] as BlockTokens)
    expect(lines[0]).toEqual({ kind: "table", header: [], rows: [], align: [] })
  })
})
