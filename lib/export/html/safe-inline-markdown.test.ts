import { renderSafeInlineMarkdown } from "./safe-inline-markdown"

describe("renderSafeInlineMarkdown", () => {
  it("renders balanced Markdown destinations and trims bare-link punctuation", () => {
    expect(
      renderSafeInlineMarkdown(
        "See [docs](https://example.com/a_(b)). Then https://example.org/x)."
      )
    ).toBe(
      'See <a href="https://example.com/a_(b)" target="_blank" rel="noreferrer">docs</a>. Then <a href="https://example.org/x" target="_blank" rel="noreferrer">https://example.org/x</a>).'
    )
  })

  it("renders data images but leaves unsafe destinations inert", () => {
    expect(renderSafeInlineMarkdown("![plot](data:image/png;base64,YQ==)")).toContain(
      '<img src="data:image/png;base64,YQ==" alt="plot"'
    )
    expect(renderSafeInlineMarkdown("[run](javascript:alert(1))")).not.toContain(
      'href="javascript:'
    )
  })
})
