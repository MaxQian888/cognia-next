import { parseMarkdownBlocks } from "./blocks"

describe("parseMarkdownBlocks", () => {
  it("parses headings at levels 1-3", () => {
    expect(parseMarkdownBlocks("# A\n## B\n### C")).toEqual([
      { kind: "heading", level: 1, text: "A" },
      { kind: "heading", level: 2, text: "B" },
      { kind: "heading", level: 3, text: "C" },
    ])
  })

  it("joins consecutive plain lines into one paragraph and splits on blanks", () => {
    expect(parseMarkdownBlocks("one\ntwo\n\nthree")).toEqual([
      { kind: "paragraph", text: "one two" },
      { kind: "paragraph", text: "three" },
    ])
  })

  it("parses bullet list items with - and *", () => {
    expect(parseMarkdownBlocks("- first\n* second")).toEqual([
      { kind: "listItem", text: "first" },
      { kind: "listItem", text: "second" },
    ])
  })

  it("captures fenced code verbatim", () => {
    const md = "intro\n```\nconst x = 1\nconst y = 2\n```\nafter"
    expect(parseMarkdownBlocks(md)).toEqual([
      { kind: "paragraph", text: "intro" },
      { kind: "code", text: "const x = 1\nconst y = 2" },
      { kind: "paragraph", text: "after" },
    ])
  })

  it("treats an unterminated code fence as a code block", () => {
    expect(parseMarkdownBlocks("```\nno close")).toEqual([{ kind: "code", text: "no close" }])
  })

  it("normalizes CRLF and returns empty for blank input", () => {
    expect(parseMarkdownBlocks("a\r\n\r\nb")).toEqual([
      { kind: "paragraph", text: "a" },
      { kind: "paragraph", text: "b" },
    ])
    expect(parseMarkdownBlocks("")).toEqual([])
  })
})
