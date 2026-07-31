import {
  A2UI_BOX_PX,
  CODE_CHROME_PX,
  CODE_LINE_PX,
  FALLBACK_ROW_PX,
  GALLERY_ROW_PX,
  GALLERY_SINGLE_PX,
  IMAGE_BOX_PX,
  MATH_BLOCK_PX,
  MAX_ROW_PX,
  MERMAID_BOX_PX,
  ROW_CHROME_PX,
  TABLE_ROW_PX,
  TEXT_LINE_PX,
  TOOL_CARD_PX,
  countMarkdownImages,
  estimateMarkdownHeight,
  estimateMessageHeight,
  fenceHeight,
  galleryHeight,
} from "./row-height-estimate"

const imagePart = (n: number) => ({
  type: "file",
  url: `data:image/png;base64,AAA${n}`,
  mediaType: "image/png",
})

describe("estimateMessageHeight", () => {
  it("falls back for a message with no parts", () => {
    expect(estimateMessageHeight({})).toBe(FALLBACK_ROW_PX)
    expect(estimateMessageHeight({ parts: [] })).toBe(FALLBACK_ROW_PX)
  })

  it("never returns less than the flat fallback", () => {
    expect(estimateMessageHeight({ parts: [{ type: "text", text: "hi" }] })).toBe(FALLBACK_ROW_PX)
  })

  it("grows with the number of images, which the flat estimate never did", () => {
    const one = estimateMessageHeight({ parts: [{ type: "text", text: "x" }, imagePart(1)] })
    const four = estimateMessageHeight({
      parts: [{ type: "text", text: "x" }, imagePart(1), imagePart(2), imagePart(3), imagePart(4)],
    })

    expect(one).toBeGreaterThan(FALLBACK_ROW_PX)
    expect(four).toBeGreaterThan(one)
  })

  it("collects images into one gallery rather than stacking them", () => {
    // Four images tile 2x2 — two gallery rows, not four image boxes.
    const parts = [imagePart(1), imagePart(2), imagePart(3), imagePart(4)]
    expect(estimateMessageHeight({ parts })).toBe(ROW_CHROME_PX + 2 * GALLERY_ROW_PX)
  })

  it("counts a non-image file part as generic chrome, not as an image", () => {
    const withPdf = estimateMessageHeight({
      parts: [{ type: "file", url: "blob:x", mediaType: "application/pdf" }],
    })
    const withImage = estimateMessageHeight({ parts: [imagePart(1)] })

    expect(withPdf).toBeLessThan(withImage)
  })

  it("ignores an image part with no url", () => {
    const parts = [{ type: "file", mediaType: "image/png" }]
    expect(estimateMessageHeight({ parts })).toBe(FALLBACK_ROW_PX)
  })

  it("charges each tool part a card", () => {
    const parts = Array.from({ length: 6 }, (_, i) => ({ type: `tool-thing-${i}` }))
    expect(estimateMessageHeight({ parts })).toBe(ROW_CHROME_PX + 6 * TOOL_CARD_PX)
  })

  it("charges reasoning its disclosure chrome on top of its prose", () => {
    const reasoning = estimateMessageHeight({
      parts: [{ type: "reasoning", text: "a".repeat(900) }],
    })
    const text = estimateMessageHeight({ parts: [{ type: "text", text: "a".repeat(900) }] })

    expect(reasoning).toBeGreaterThan(text)
  })

  it("skips parts with no type at all", () => {
    expect(estimateMessageHeight({ parts: [{}, {}] })).toBe(FALLBACK_ROW_PX)
  })

  it("clamps a pathological body instead of reporting its true height", () => {
    const code = "```ts\n" + "line\n".repeat(20_000) + "```"
    expect(estimateMessageHeight({ parts: [{ type: "text", text: code }] })).toBe(MAX_ROW_PX)
  })

  it("memoizes per parts array so repeated measure passes do not rewalk", () => {
    const parts = [{ type: "text", text: "a".repeat(500) }]
    const first = estimateMessageHeight({ parts })
    // Mutating in place is exactly what the cache is allowed to miss: the
    // renderer replaces the array rather than editing it.
    ;(parts[0] as { text: string }).text = "a".repeat(50_000)

    expect(estimateMessageHeight({ parts })).toBe(first)
    expect(estimateMessageHeight({ parts: [...parts] })).toBeGreaterThan(first)
  })
})

describe("estimateMarkdownHeight", () => {
  it("is zero for empty text", () => {
    expect(estimateMarkdownHeight("")).toBe(0)
  })

  it("charges a full line per wrapped line and a half for blanks", () => {
    expect(estimateMarkdownHeight("short")).toBe(TEXT_LINE_PX)
    expect(estimateMarkdownHeight("short\n\nshort")).toBe(2.5 * TEXT_LINE_PX)
  })

  it("wraps a long line into several", () => {
    expect(estimateMarkdownHeight("a".repeat(271))).toBe(4 * TEXT_LINE_PX)
  })

  it("charges a code fence by its line count", () => {
    expect(estimateMarkdownHeight("```ts\na\nb\nc\n```")).toBe(CODE_CHROME_PX + 3 * CODE_LINE_PX)
  })

  it("charges a mermaid fence a diagram box regardless of source length", () => {
    const short = estimateMarkdownHeight("```mermaid\ngraph TD\n```")
    const long = estimateMarkdownHeight("```mermaid\n" + "a-->b\n".repeat(80) + "```")

    expect(short).toBe(MERMAID_BOX_PX)
    expect(long).toBe(MERMAID_BOX_PX)
  })

  it("scores an unterminated fence as if it closed, which is a mid-stream turn", () => {
    expect(estimateMarkdownHeight("```ts\na\nb")).toBe(CODE_CHROME_PX + 2 * CODE_LINE_PX)
  })

  it("does not treat a fence-looking line inside a fence as a close-then-open", () => {
    // Two fences, not three: the inner line closes the first.
    expect(estimateMarkdownHeight("```\na\n```\n```\nb\n```")).toBe(
      2 * CODE_CHROME_PX + 2 * CODE_LINE_PX
    )
  })

  it("charges table rows individually", () => {
    const table = "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |"
    expect(estimateMarkdownHeight(table)).toBe(4 * TABLE_ROW_PX)
  })

  it("resumes prose accounting after a table ends", () => {
    const body = "| a |\n| - |\nafter"
    expect(estimateMarkdownHeight(body)).toBe(2 * TABLE_ROW_PX + TEXT_LINE_PX)
  })

  it("charges a markdown image its reserved box instead of a line of prose", () => {
    expect(estimateMarkdownHeight("![alt](https://x/y.png)")).toBe(IMAGE_BOX_PX)
    expect(estimateMarkdownHeight("![a](x) ![b](y)")).toBe(2 * IMAGE_BOX_PX)
  })

  it("keeps a table open across its own rows but closes it before a fence", () => {
    const body = "| a |\n```ts\nx\n```"
    expect(estimateMarkdownHeight(body)).toBe(TABLE_ROW_PX + CODE_CHROME_PX + CODE_LINE_PX)
  })
})

describe("fenceHeight", () => {
  it("maps rendered fences to their block, and everything else to code lines", () => {
    expect(fenceHeight("mermaid", 99)).toBe(MERMAID_BOX_PX)
    expect(fenceHeight("MERMAID", 1)).toBe(MERMAID_BOX_PX)
    expect(fenceHeight("a2ui", 40)).toBe(A2UI_BOX_PX)
    expect(fenceHeight("math", 2)).toBe(MATH_BLOCK_PX)
    expect(fenceHeight("", 5)).toBe(CODE_CHROME_PX + 5 * CODE_LINE_PX)
    expect(fenceHeight("python", 5)).toBe(CODE_CHROME_PX + 5 * CODE_LINE_PX)
  })
})

describe("galleryHeight", () => {
  it("gives a lone image its own box and tiles the rest two per row", () => {
    expect(galleryHeight(0)).toBe(0)
    expect(galleryHeight(-1)).toBe(0)
    expect(galleryHeight(1)).toBe(GALLERY_SINGLE_PX)
    expect(galleryHeight(2)).toBe(GALLERY_ROW_PX)
    expect(galleryHeight(3)).toBe(2 * GALLERY_ROW_PX)
  })

  it("is shorter for a 2-up row than for a lone image, matching the grid", () => {
    // Not a bug: squares in a half-width `max-w-sm` column are 189px, while a
    // single image gets the full `max-h-72`.
    expect(galleryHeight(2)).toBeLessThan(galleryHeight(1))
    expect(galleryHeight(4)).toBeGreaterThan(galleryHeight(1))
  })
})

describe("countMarkdownImages", () => {
  it("counts image syntax and ignores plain links", () => {
    expect(countMarkdownImages("no images here")).toBe(0)
    expect(countMarkdownImages("[link](href)")).toBe(0)
    expect(countMarkdownImages("![a](x)")).toBe(1)
    expect(countMarkdownImages("![a](x) and ![b](y)")).toBe(2)
  })

  it("stops at an unterminated image", () => {
    expect(countMarkdownImages("![oops")).toBe(0)
  })
})
