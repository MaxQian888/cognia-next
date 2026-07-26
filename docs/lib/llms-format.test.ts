import { fromMarkdownSlug, markdownHref, renderPageMarkdown, toMarkdownSlug } from "./llms-format"

describe("toMarkdownSlug", () => {
  it("appends the extension to the last segment only", () => {
    expect(toMarkdownSlug(["subsystems", "memory"])).toEqual(["subsystems", "memory.md"])
  })

  it("maps the locale index onto index.md", () => {
    expect(toMarkdownSlug([])).toEqual(["index.md"])
  })
})

describe("fromMarkdownSlug", () => {
  it("round-trips a nested page", () => {
    expect(fromMarkdownSlug(toMarkdownSlug(["subsystems", "memory"]))).toEqual([
      "subsystems",
      "memory",
    ])
  })

  it("round-trips the locale index back to empty slugs", () => {
    expect(fromMarkdownSlug(toMarkdownSlug([]))).toEqual([])
  })

  it("rejects a path without the Markdown extension", () => {
    expect(fromMarkdownSlug(["subsystems", "memory"])).toBeNull()
  })

  it("rejects an empty or missing slug", () => {
    expect(fromMarkdownSlug([])).toBeNull()
    expect(fromMarkdownSlug(undefined)).toBeNull()
  })

  it("rejects a bare extension with no stem", () => {
    expect(fromMarkdownSlug(["subsystems", ".md"])).toBeNull()
  })

  it("keeps a nested page that merely ends in index", () => {
    // Only the single-segment `index.md` is the locale root; fumadocs folds
    // `<folder>/index.mdx` into the folder slug, so this stays literal.
    expect(fromMarkdownSlug(["guides", "index.md"])).toEqual(["guides", "index"])
  })
})

describe("markdownHref", () => {
  it("builds the locale-scoped Markdown twin path", () => {
    expect(markdownHref("en", ["subsystems", "memory"])).toBe("/md/en/subsystems/memory.md")
  })

  it("points the locale index at index.md", () => {
    expect(markdownHref("zh", [])).toBe("/md/zh/index.md")
  })
})

describe("renderPageMarkdown", () => {
  it("emits parseable frontmatter followed by the body", () => {
    expect(
      renderPageMarkdown({
        title: "Memory",
        description: "Long-term memory",
        url: "https://docs.example.com/en/docs/subsystems/memory",
        content: "  # Memory\n\nBody.  ",
      })
    ).toBe(
      [
        "---",
        'title: "Memory"',
        'description: "Long-term memory"',
        'url: "https://docs.example.com/en/docs/subsystems/memory"',
        "---",
        "",
        "# Memory",
        "",
        "Body.",
        "",
      ].join("\n")
    )
  })

  it("omits the description line when the page has none", () => {
    const output = renderPageMarkdown({
      title: "Memory",
      url: "https://docs.example.com/en/docs/subsystems/memory",
      content: "Body.",
    })
    expect(output).not.toContain("description:")
  })

  it("escapes quotes in the title so the frontmatter stays valid", () => {
    const output = renderPageMarkdown({
      title: 'The "unified" agent',
      url: "https://docs.example.com/en/docs",
      content: "Body.",
    })
    expect(output).toContain('title: "The \\"unified\\" agent"')
  })
})
