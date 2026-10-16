import { parseInline, parseMarkdown, safeHref } from "./markdown"

describe("safeHref", () => {
  it("keeps web and mail links only", () => {
    expect(safeHref("https://a.test/x")).toBe("https://a.test/x")
    expect(safeHref("mailto:a@b.test")).toBe("mailto:a@b.test")
    expect(safeHref("javascript:alert(1)")).toBeNull()
    expect(safeHref("data:text/html,<b>")).toBeNull()
    expect(safeHref("/relative")).toBeNull()
  })
})

describe("parseInline", () => {
  it("parses emphasis, code, strike and links", () => {
    expect(parseInline("a **b** *c* `d` ~~e~~ [f](https://f.test)")).toEqual([
      { type: "text", text: "a " },
      { type: "strong", children: [{ type: "text", text: "b" }] },
      { type: "text", text: " " },
      { type: "em", children: [{ type: "text", text: "c" }] },
      { type: "text", text: " " },
      { type: "code", text: "d" },
      { type: "text", text: " " },
      { type: "del", children: [{ type: "text", text: "e" }] },
      { type: "text", text: " " },
      { type: "link", href: "https://f.test/", children: [{ type: "text", text: "f" }] },
    ])
  })

  it("renders a link to an unsafe target as its text", () => {
    expect(parseInline("[click](javascript:alert(1))")).toEqual([{ type: "text", text: "click" }])
  })

  it("never treats markup as anything but text", () => {
    expect(parseInline("<script>alert(1)</script>")).toEqual([
      { type: "text", text: "<script>alert(1)</script>" },
    ])
  })

  it("links autolinks and bare URLs, leaving trailing punctuation", () => {
    expect(parseInline("see <https://a.test> or https://b.test/x.")).toEqual([
      { type: "text", text: "see " },
      {
        type: "link",
        href: "https://a.test/",
        children: [{ type: "text", text: "https://a.test" }],
      },
      { type: "text", text: " or " },
      {
        type: "link",
        href: "https://b.test/x",
        children: [{ type: "text", text: "https://b.test/x" }],
      },
      { type: "text", text: "." },
    ])
  })

  it("leaves snake_case, escapes and unclosed markers alone", () => {
    expect(parseInline("snake_case_name \\*not\\* *open")).toEqual([
      { type: "text", text: "snake_case_name *not* *open" },
    ])
  })

  it("keeps code spans literal", () => {
    expect(parseInline("`**x**` and ``a ` b``")).toEqual([
      { type: "code", text: "**x**" },
      { type: "text", text: " and " },
      { type: "code", text: "a ` b" },
    ])
  })

  it("turns a newline into a break", () => {
    expect(parseInline("a\nb")).toEqual([
      { type: "text", text: "a" },
      { type: "break" },
      { type: "text", text: "b" },
    ])
  })
})

describe("parseMarkdown", () => {
  it("parses headings, paragraphs, rules and code fences", () => {
    expect(
      parseMarkdown("# Title\n\nSome text\nmore\n\n---\n\n```ts\nconst a = '<b>'\n```")
    ).toEqual([
      { type: "heading", level: 1, children: [{ type: "text", text: "Title" }] },
      {
        type: "paragraph",
        children: [
          { type: "text", text: "Some text" },
          { type: "break" },
          { type: "text", text: "more" },
        ],
      },
      { type: "rule" },
      { type: "code", lang: "ts", text: "const a = '<b>'" },
    ])
  })

  it("parses lists, nested lists and ordered starts", () => {
    const [list] = parseMarkdown("- one\n- two\n  - inner\n- three")
    expect(list).toMatchObject({ type: "list", ordered: false })
    if (list?.type !== "list") throw new Error("unreachable")
    expect(list.items).toHaveLength(3)
    expect(list.items[1]?.[1]).toMatchObject({ type: "list", items: [[{ type: "paragraph" }]] })
    expect(parseMarkdown("3. c\n4. d")[0]).toMatchObject({ type: "list", ordered: true, start: 3 })
  })

  it("keeps a list together across blank lines between items", () => {
    const blocks = parseMarkdown("1. a\n\n2. b")
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      type: "list",
      items: [[{ type: "paragraph" }], [{ type: "paragraph" }]],
    })
  })

  it("parses quotes with their own blocks", () => {
    expect(parseMarkdown("> # Q\n> text")).toEqual([
      {
        type: "quote",
        children: [
          { type: "heading", level: 1, children: [{ type: "text", text: "Q" }] },
          { type: "paragraph", children: [{ type: "text", text: "text" }] },
        ],
      },
    ])
  })

  it("parses tables with alignment and escaped pipes", () => {
    expect(parseMarkdown("| a | b |\n|:--|--:|\n| 1 \\| x | 2 |\n| 3 |")).toEqual([
      {
        type: "table",
        align: ["left", "right"],
        header: [[{ type: "text", text: "a" }], [{ type: "text", text: "b" }]],
        rows: [
          [[{ type: "text", text: "1 | x" }], [{ type: "text", text: "2" }]],
          [[{ type: "text", text: "3" }], []],
        ],
      },
    ])
  })

  it("closes an unterminated fence at the end", () => {
    expect(parseMarkdown("```\nopen")).toEqual([{ type: "code", lang: "", text: "open" }])
  })

  it("bounds nesting", () => {
    const deep = parseMarkdown(">".repeat(20) + " x")
    let depth = 0
    let node = deep[0]
    while (node?.type === "quote") {
      depth++
      node = node.children[0]
    }
    expect(depth).toBeLessThanOrEqual(8)
  })
})
