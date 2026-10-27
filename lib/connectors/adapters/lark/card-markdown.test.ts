import { larkCardMarkdownToCommonMark } from "./card-markdown"

describe("larkCardMarkdownToCommonMark", () => {
  it("preserves platform tags and newlines inside multiline code spans", () => {
    const source = "`line one\n<at id=all></at>\nline three`\n<at id=all></at>"
    expect(larkCardMarkdownToCommonMark(source)).toBe(
      "`line one\n<at id=all></at>\nline three`  \n@all"
    )
  })

  it("preserves fences nested in blockquotes", () => {
    const source = "> ```\n> <at id=all></at>\n> ```\n<at id=all></at>"
    expect(larkCardMarkdownToCommonMark(source)).toBe("> ```\n> <at id=all></at>\n> ```\n@all")
  })
  it("turns platform tags into plain Markdown", () => {
    expect(
      larkCardMarkdownToCommonMark(
        "**Hi** <at id=all></at> <at user_id=\"ou_1\">Alice</at> <font color='red'>red</font>\nnext <text_tag color='blue'>tag</text_tag> <link url=\"https://x.test\">go</link><br>end"
      )
    ).toBe("**Hi** @all @Alice red  \nnext `tag` [go](https://x.test)  \nend")
  })

  it("falls back to the id for a mention without a name", () => {
    expect(larkCardMarkdownToCommonMark("<at id=ou_2></at> ok")).toBe("@ou_2 ok")
    expect(larkCardMarkdownToCommonMark("<at email='a@b.test'></at>")).toBe("@a@b.test")
  })

  it("keeps a link without url as its label", () => {
    expect(larkCardMarkdownToCommonMark("<link>label</link>")).toBe("label")
  })

  it("leaves standard Markdown and fenced code alone", () => {
    expect(larkCardMarkdownToCommonMark("- a\n- b\n\n```\nx\ny\n```")).toBe(
      "- a  \n- b\n\n```\nx\ny\n```"
    )
  })

  it("leaves platform tags inside tilde fences, long spans and unclosed fences untouched", () => {
    expect(larkCardMarkdownToCommonMark("~~~\n<at id=all></at>\n~~~")).toBe(
      "~~~\n<at id=all></at>\n~~~"
    )
    expect(larkCardMarkdownToCommonMark("``a ` <at id=all></at>``")).toBe(
      "``a ` <at id=all></at>``"
    )
    expect(larkCardMarkdownToCommonMark("x\n```\n<at id=all></at>")).toBe(
      "x\n```\n<at id=all></at>"
    )
  })

  it("leaves platform tags inside code untouched", () => {
    expect(larkCardMarkdownToCommonMark("```\n<at id=all></at>\n```")).toBe(
      "```\n<at id=all></at>\n```"
    )
    expect(larkCardMarkdownToCommonMark("use `<font color=red>` and <at id=all></at>")).toBe(
      "use `<font color=red>` and @all"
    )
  })

  it("stays linear on a run of unmatched tags", () => {
    const hostile = "<at>".repeat(50_000) + "<link url=x>".repeat(10_000)
    const started = performance.now()
    larkCardMarkdownToCommonMark(hostile)
    // Quadratic matching took seconds at this size; linear takes milliseconds.
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
