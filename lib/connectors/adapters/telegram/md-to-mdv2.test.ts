import { mdToMarkdownV2 } from "./md-to-mdv2"

describe("mdToMarkdownV2 — inline markup", () => {
  it("converts **bold** to *bold*", () => {
    expect(mdToMarkdownV2("**bold**")).toBe("*bold*")
  })

  it("converts __bold__ to *bold*", () => {
    expect(mdToMarkdownV2("__bold__")).toBe("*bold*")
  })

  it("converts *italic* and _italic_ to _italic_", () => {
    expect(mdToMarkdownV2("*italic*")).toBe("_italic_")
    expect(mdToMarkdownV2("_italic_")).toBe("_italic_")
  })

  it("does not treat intraword underscores as italic", () => {
    expect(mdToMarkdownV2("snake_case_name")).toBe("snake\\_case\\_name")
  })

  it("converts ~~strike~~ to ~strike~", () => {
    expect(mdToMarkdownV2("~~gone~~")).toBe("~gone~")
  })

  it("supports nested markup inside bold", () => {
    expect(mdToMarkdownV2("**bold _inner_**")).toBe("*bold _inner_*")
  })

  it("escapes surrounding plain text but keeps markup", () => {
    expect(mdToMarkdownV2("a + b **c** (d)")).toBe("a \\+ b *c* \\(d\\)")
  })

  it("renders inline code with code-context escaping only (audited fix #4a)", () => {
    // Inside a code entity only ` and \ are escaped — a.b() stays literal.
    expect(mdToMarkdownV2("`a.b()`")).toBe("`a.b()`")
    expect(mdToMarkdownV2("`tick \\` + back\\slash`")).toBe("`tick \\\\` \\+ back\\\\slash\\`")
  })

  it("keeps MarkdownV2 specials unescaped inside inline code except ` and \\", () => {
    expect(mdToMarkdownV2("`x_y! #tag {a} [b]`")).toBe("`x_y! #tag {a} [b]`")
  })

  it("escapes backslash sequences in plain text (audited fix #4b)", () => {
    expect(mdToMarkdownV2("literal \\. dot")).toBe("literal \\\\\\. dot")
  })

  it("converts links, escaping ) and \\ in the URL (audited fix #4c)", () => {
    expect(mdToMarkdownV2("[docs](https://x.dev/a_(b))")).toBe("[docs](https://x.dev/a_(b\\))")
  })

  it("escapes MarkdownV2 specials in the link text", () => {
    expect(mdToMarkdownV2("[a.b!](https://x.dev)")).toBe("[a\\.b\\!](https://x.dev)")
  })
})

describe("mdToMarkdownV2 — block structure", () => {
  it("renders headings as bold lines", () => {
    expect(mdToMarkdownV2("# Title")).toBe("*Title*")
    expect(mdToMarkdownV2("### Sub.title")).toBe("*Sub\\.title*")
  })

  it("renders blockquotes with the MarkdownV2 > prefix", () => {
    expect(mdToMarkdownV2("> quoted text.")).toBe(">quoted text\\.")
  })

  it("renders unordered and ordered lists as hyphen lines", () => {
    expect(mdToMarkdownV2("- one\n* two\n1. three")).toBe("\\- one\n\\- two\n\\- three")
  })

  it("preserves list indentation", () => {
    expect(mdToMarkdownV2("  - nested")).toBe("  \\- nested")
  })

  it("renders fenced code blocks with code-context escaping only", () => {
    const md = "```ts\nconst x = a.b(1) + `tpl`\n```"
    expect(mdToMarkdownV2(md)).toBe("```ts\nconst x = a.b(1) + \\`tpl\\`\n```")
  })

  it("handles fences without a language", () => {
    expect(mdToMarkdownV2("```\nplain#text!\n```")).toBe("```\nplain#text!\n```")
  })

  it("closes unterminated fences at EOF", () => {
    expect(mdToMarkdownV2("```\ndangling")).toBe("```\ndangling\n```")
  })

  it("does not parse inline markup inside fences", () => {
    expect(mdToMarkdownV2("```\n**not bold**\n```")).toBe("```\n**not bold**\n```")
  })

  it("converts a mixed document end-to-end", () => {
    const md = [
      "# Report",
      "",
      "Results for **run 42** (see [log](https://x.dev/l_(1))):",
      "",
      "- passed: 10",
      "- failed: 2",
      "",
      "```sh",
      "npm test -- --ci",
      "```",
    ].join("\n")
    expect(mdToMarkdownV2(md)).toBe(
      [
        "*Report*",
        "",
        "Results for *run 42* \\(see [log](https://x.dev/l_(1\\))\\):",
        "",
        "\\- passed: 10",
        "\\- failed: 2",
        "",
        "```sh",
        "npm test -- --ci",
        "```",
      ].join("\n")
    )
  })
})
