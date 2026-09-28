import {
  blocksToMarkdown,
  inline,
  markdownConversionNotes,
  parseMarkdownBlocks,
  type MarkdownConversionNote,
} from "./markdown"
import { materializeBlock, type DocumentBlock } from "./model"

function blocks(markdown: string) {
  return parseMarkdownBlocks(markdown).blocks
}

describe("parseMarkdownBlocks", () => {
  it("maps ATX and setext headings to levels 1–6", () => {
    expect(
      blocks("# One\n## Two ##\n###### Six\n\nSetext\n===\n\nSub\n---\n\n#\n\n#nospace")
    ).toEqual([
      { type: "heading", level: 1, text: "One" },
      { type: "heading", level: 2, text: "Two" },
      { type: "heading", level: 6, text: "Six" },
      { type: "heading", level: 1, text: "Setext" },
      { type: "heading", level: 2, text: "Sub" },
      { type: "paragraph", text: "#nospace" },
    ])
  })

  it("joins soft breaks with spaces and keeps hard breaks as newlines", () => {
    expect(blocks("first line\nsecond line  \nthird\\\nfourth\n\nnext")).toEqual([
      { type: "paragraph", text: "first line second line\nthird\nfourth" },
      { type: "paragraph", text: "next" },
    ])
  })

  it("nests bullet and ordered lists by indentation and continues items", () => {
    expect(
      blocks(
        [
          "- top",
          "  - nested",
          "    - deeper",
          "  - back",
          "  continued",
          "- [x] done",
          "- [ ] todo",
          "",
          "1. first",
          "2) second",
          "   1. inner",
        ].join("\n")
      )
    ).toEqual([
      { type: "list-item", ordered: false, level: 0, text: "top" },
      { type: "list-item", ordered: false, level: 1, text: "nested" },
      { type: "list-item", ordered: false, level: 2, text: "deeper" },
      { type: "list-item", ordered: false, level: 1, text: "back continued" },
      { type: "list-item", ordered: false, level: 0, text: "☑ done" },
      { type: "list-item", ordered: false, level: 0, text: "☐ todo" },
      { type: "list-item", ordered: true, level: 0, text: "first" },
      { type: "list-item", ordered: true, level: 0, text: "second" },
      { type: "list-item", ordered: true, level: 1, text: "inner" },
    ])
  })

  it("continues a wrapped item and restarts the nesting at an outdent", () => {
    expect(blocks("  - item\nwrapped line\n- outdented\n\ntail")).toEqual([
      { type: "list-item", ordered: false, level: 0, text: "item wrapped line" },
      { type: "list-item", ordered: false, level: 0, text: "outdented" },
      { type: "paragraph", text: "tail" },
    ])
  })

  it("only lets a bullet or a list starting at 1 interrupt a paragraph", () => {
    expect(blocks("The year\n2024. was good")).toEqual([
      { type: "paragraph", text: "The year 2024. was good" },
    ])
    expect(blocks("Intro\n- item")).toEqual([
      { type: "paragraph", text: "Intro" },
      { type: "list-item", ordered: false, level: 0, text: "item" },
    ])
  })

  it("keeps fenced and indented code verbatim with its language", () => {
    expect(
      blocks(
        "```ts\nconst a = 1\n  indented()\n```\n\n~~~\nraw **not bold**\n~~~\n\n    four spaces\n    more"
      )
    ).toEqual([
      { type: "code", text: "const a = 1\n  indented()", language: "ts" },
      { type: "code", text: "raw **not bold**" },
      { type: "code", text: "four spaces\nmore" },
    ])
  })

  it("reads an unclosed fence to the end of the input", () => {
    expect(blocks("```\nopen")).toEqual([{ type: "code", text: "open" }])
  })

  it("splits quotes into one block per quoted paragraph, with lazy continuation", () => {
    expect(blocks("> first\nlazy\n>\n> > nested second\n\nafter")).toEqual([
      { type: "quote", text: "first lazy" },
      { type: "quote", text: "nested second" },
      { type: "paragraph", text: "after" },
    ])
  })

  it("parses GFM tables, escaped pipes, <br>, and pads short rows", () => {
    expect(
      blocks("| Name | Note |\n| :--- | ---: |\n| a \\| b | x<br>y |\n| solo |\n\nafter")
    ).toEqual([
      {
        type: "table",
        rows: [
          ["Name", "Note"],
          ["a | b", "x\ny"],
          ["solo", ""],
        ],
      },
      { type: "paragraph", text: "after" },
    ])
    // A pipe line without a separator row is just a paragraph.
    expect(blocks("a | b\nc | d")).toEqual([{ type: "paragraph", text: "a | b c | d" }])
  })

  it("drops thematic breaks and comment-only lines, and records what was lost", () => {
    const result = parseMarkdownBlocks("one\n\n---\n\n<!-- block:b9 -->\ntwo\n\n***")
    expect(result.blocks).toEqual([
      { type: "paragraph", text: "one" },
      { type: "paragraph", text: "two" },
    ])
    expect(result.notes).toEqual(["thematic-breaks"])
  })

  it("normalizes CRLF input", () => {
    expect(blocks("# A\r\n\r\nb")).toEqual([
      { type: "heading", level: 1, text: "A" },
      { type: "paragraph", text: "b" },
    ])
  })
})

describe("inline", () => {
  const flatten = (source: string) => {
    const notes = new Set<MarkdownConversionNote>()
    return { text: inline(source, notes), notes: [...notes].sort() }
  }

  it("removes emphasis, strong, and strikethrough markers", () => {
    expect(flatten("**bold** and __strong__, *em* _em_ ~~gone~~")).toEqual({
      text: "bold and strong, em em gone",
      notes: ["inline-formatting"],
    })
  })

  it("keeps literal asterisks, snake_case, and backslash escapes", () => {
    expect(flatten("5 * 3 * 2 and snake_case_name and \\*not em\\* and \\#tag")).toEqual({
      text: "5 * 3 * 2 and snake_case_name and *not em* and #tag",
      notes: [],
    })
  })

  it("keeps code-span content literal", () => {
    expect(flatten("run `a *b* c` now")).toEqual({
      text: "run a *b* c now",
      notes: ["inline-formatting"],
    })
  })

  it("flattens links, autolinks, and images", () => {
    expect(
      flatten(
        "[docs](https://x.dev) <https://y.dev> [https://z.dev](https://z.dev) ![chart](c.png)"
      )
    ).toEqual({
      text: "docs (https://x.dev) https://y.dev https://z.dev chart",
      notes: ["images", "links"],
    })
  })

  it("notes raw HTML it keeps as text", () => {
    expect(flatten("a<br>b <span>c</span>")).toEqual({
      text: "a\nb <span>c</span>",
      notes: ["html"],
    })
  })
})

it("collects conversion notes across several sources", () => {
  expect(markdownConversionNotes(["**x**", "plain", "![i](u)"]).sort()).toEqual([
    "images",
    "inline-formatting",
  ])
})

describe("blocksToMarkdown", () => {
  const model = (inputs: Parameters<typeof materializeBlock>[0][]): DocumentBlock[] =>
    inputs.map((input, index) => materializeBlock(input, `b${index + 1}`))

  it("renders every block type", () => {
    expect(
      blocksToMarkdown(
        model([
          { type: "heading", level: 3, text: "Scope" },
          { type: "paragraph", text: "Line one\nline two" },
          { type: "list-item", ordered: true, text: "first" },
          { type: "list-item", ordered: true, level: 1, text: "nested" },
          { type: "list-item", ordered: true, text: "second" },
          { type: "quote", text: "Quoted\nagain" },
          { type: "code", text: "const x = `y`", language: "ts" },
          { type: "table", rows: [["A", "B|C"], ["1"]] },
        ])
      )
    ).toBe(
      [
        "### Scope",
        "",
        "Line one  \nline two",
        "",
        "1. first\n   1. nested\n2. second",
        "",
        "> Quoted  \n> again",
        "",
        "```ts\nconst x = `y`\n```",
        "",
        "| A | B\\|C |\n| --- | --- |\n| 1 |  |",
      ].join("\n")
    )
  })

  it("escapes text that would otherwise re-parse as structure or formatting", () => {
    const markdown = blocksToMarkdown(
      model([
        { type: "paragraph", text: "# not a heading" },
        { type: "paragraph", text: "1. not a list" },
        { type: "paragraph", text: "- not a bullet" },
        { type: "paragraph", text: "*not em* and snake_case" },
      ])
    )
    expect(blocks(markdown)).toEqual([
      { type: "paragraph", text: "# not a heading" },
      { type: "paragraph", text: "1. not a list" },
      { type: "paragraph", text: "- not a bullet" },
      { type: "paragraph", text: "*not em* and snake_case" },
    ])
  })

  it("round-trips its own output, including block-id markers", () => {
    const source = model([
      { type: "heading", level: 1, text: "Title" },
      { type: "paragraph", text: "Body with **stars** and\na break" },
      { type: "list-item", ordered: false, text: "bullet" },
      { type: "list-item", ordered: false, level: 1, text: "nested" },
      { type: "list-item", ordered: false, level: 2, text: "deep" },
      { type: "quote", text: "said" },
      { type: "code", text: "  x()\n\ny()", language: "js" },
      {
        type: "table",
        rows: [
          ["h1", "h2"],
          ["a", "b\nc"],
        ],
      },
    ])
    for (const blockIds of [false, true]) {
      const parsed = blocks(blocksToMarkdown(source, { blockIds }))
      expect(parsed).toEqual(
        source.map(({ id: _id, ...rest }) =>
          rest.type === "list-item" ? { ...rest, level: rest.level ?? 0 } : rest
        )
      )
    }
  })

  it("fences code without a language, longer than any backtick run inside", () => {
    expect(blocksToMarkdown(model([{ type: "code", text: "a ``` b" }]))).toBe("````\na ``` b\n````")
  })

  it("marks each block with its id when asked", () => {
    expect(
      blocksToMarkdown(
        model([
          { type: "paragraph", text: "a" },
          { type: "list-item", text: "b" },
        ]),
        { blockIds: true }
      )
    ).toBe("<!-- block:b1 -->\na\n\n<!-- block:b2 -->\n- b")
  })

  it("reads a list that skips a nesting level back one level shallower", () => {
    const markdown = blocksToMarkdown(
      model([
        { type: "list-item", text: "top" },
        { type: "list-item", level: 2, text: "skipped" },
      ])
    )
    expect(blocks(markdown).map((block) => (block as { level?: number }).level)).toEqual([0, 1])
  })
})
