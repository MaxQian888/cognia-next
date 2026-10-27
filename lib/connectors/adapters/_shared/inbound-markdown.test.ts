import {
  escapeMarkdown,
  markdownLinkDestination,
  preserveLineBreaks,
  splitMarkdownCode,
} from "./inbound-markdown"

describe("preserveLineBreaks", () => {
  it("hard-breaks single newlines and keeps paragraph breaks", () => {
    expect(preserveLineBreaks("a\nb\n\nc")).toBe("a  \nb\n\nc")
  })

  it("does not touch fenced code or the line before a fence", () => {
    expect(preserveLineBreaks("intro\n```\nx\ny\n```\nafter\nend")).toBe(
      "intro\n```\nx\ny\n```\nafter  \nend"
    )
  })

  it("does not double existing hard breaks", () => {
    expect(preserveLineBreaks("a  \nb")).toBe("a  \nb")
  })
})

describe("markdownLinkDestination", () => {
  it("encodes characters that would end a link destination", () => {
    expect(markdownLinkDestination("https://x.test/run(1) a")).toBe("https://x.test/run%281%29%20a")
    expect(markdownLinkDestination("https://x.test/a?b=1&c=2")).toBe("https://x.test/a?b=1&c=2")
  })
})

describe("preserveLineBreaks fences", () => {
  it("treats ~~~ fences and unclosed fences as code", () => {
    expect(preserveLineBreaks("a\nb\n~~~\nx\ny\n~~~\nc\nd")).toBe("a  \nb\n~~~\nx\ny\n~~~\nc  \nd")
    expect(preserveLineBreaks("a\n```\nx\ny")).toBe("a\n```\nx\ny")
  })
})

describe("splitMarkdownCode", () => {
  const code = (md: string) =>
    splitMarkdownCode(md)
      .filter((c) => c.code)
      .map((c) => c.text)

  it("separates fenced blocks (``` and ~~~) and inline spans from prose", () => {
    expect(code("p\n~~~\n<at>\n~~~\nq `x` r")).toEqual(["~~~\n<at>\n~~~\n", "`x`"])
  })

  it("runs an unclosed fence to the end", () => {
    expect(code("p\n```\n<at>\nmore")).toEqual(["```\n<at>\nmore"])
  })

  it("matches backtick runs of equal length", () => {
    expect(code("a ``x ` y`` b `z`")).toEqual(["``x ` y``", "`z`"])
    expect(code("a `` b")).toEqual([])
  })

  it("round-trips the input", () => {
    const md = "x `a` y\n```js\nz\n```\n~~~\nw"
    expect(
      splitMarkdownCode(md)
        .map((c) => c.text)
        .join("")
    ).toBe(md)
  })

  it("stays linear on a line of unmatched backtick runs", () => {
    const hostile = Array.from({ length: 20_000 }, (_, i) => "`".repeat((i % 50) + 1)).join(" ")
    const started = performance.now()
    splitMarkdownCode(hostile)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

describe("escapeMarkdown", () => {
  it("escapes inline markup and block markers", () => {
    expect(escapeMarkdown("# h *b* [l] <t> a_b")).toBe("\\# h \\*b\\* \\[l\\] \\<t\\> a\\_b")
    expect(escapeMarkdown("1. one")).toBe("1\\. one")
  })
})

describe("code containers", () => {
  it("does not extend an unclosed quote fence into the next paragraph", () => {
    expect(splitMarkdownCode("> ```\n> inside\n\noutside")).toEqual([
      { code: true, text: "> ```\n> inside\n" },
      { code: false, text: "\noutside" },
    ])
    expect(splitMarkdownCode("`before\n\nafter`").every((chunk) => !chunk.code)).toBe(true)
  })
  it("does not add hard breaks inside a multiline inline span", () => {
    expect(preserveLineBreaks("`a\nb`\nc")).toBe("`a\nb`  \nc")
    expect(splitMarkdownCode("`a\nb`")).toEqual([{ code: true, text: "`a\nb`" }])
  })

  it("recognizes fences nested in a quote", () => {
    const source = "> ~~~\n> a\n> b\n> ~~~"
    expect(preserveLineBreaks(source)).toBe(source)
    expect(splitMarkdownCode(source)).toEqual([{ code: true, text: source }])
  })
})
