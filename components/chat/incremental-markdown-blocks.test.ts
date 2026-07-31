import { createIncrementalMarkdownBlockParser } from "./incremental-markdown-blocks"

const parseMarkdownIntoBlocks = (markdown: string): string[] =>
  markdown.split(/(\n\n+)/).filter((block) => block.length > 0)

describe("createIncrementalMarkdownBlockParser", () => {
  it("matches a full parse while content grows across Markdown boundaries", () => {
    const incremental = createIncrementalMarkdownBlockParser(parseMarkdownIntoBlocks)
    const revisions = [
      "Paragraph",
      "Paragraph one.\n\n",
      "Paragraph one.\n\n```ts\nconst value = 1",
      "Paragraph one.\n\n```ts\nconst value = 1\n```\n\nFinal **bold",
      "Paragraph one.\n\n```ts\nconst value = 1\n```\n\nFinal **bold** text.",
    ]

    for (const markdown of revisions) {
      expect(incremental(markdown)).toEqual(parseMarkdownIntoBlocks(markdown))
    }
  })

  it("reparses only the unstable tail for append-only streaming updates", () => {
    const parse = jest.fn(parseMarkdownIntoBlocks)
    const incremental = createIncrementalMarkdownBlockParser(parse)
    const initial = `${"stable paragraph\n\n".repeat(1_000)}active`

    incremental(initial)
    parse.mockClear()
    const next = `${initial} tail`
    expect(incremental(next)).toEqual(parseMarkdownIntoBlocks(next))

    expect(parse).toHaveBeenCalledTimes(1)
    expect((parse.mock.calls[0]?.[0] ?? "").length).toBeLessThan(100)
  })

  it("falls back to a full parse when content is replaced or truncated", () => {
    const parse = jest.fn(parseMarkdownIntoBlocks)
    const incremental = createIncrementalMarkdownBlockParser(parse)
    incremental("first paragraph\n\nsecond")
    parse.mockClear()

    expect(incremental("replacement")).toEqual(parseMarkdownIntoBlocks("replacement"))
    expect(parse).toHaveBeenCalledWith("replacement")
  })
})
