import { extractPlainText } from "./extract-plain-text"

describe("extractPlainText", () => {
  it("returns empty string when parts is not an array", () => {
    expect(extractPlainText(null)).toBe("")
    expect(extractPlainText(undefined)).toBe("")
    expect(extractPlainText({})).toBe("")
  })

  it("concatenates text parts with a single space and trims whitespace", () => {
    expect(
      extractPlainText([
        { type: "text", text: "hello" },
        { type: "text", text: "world  " },
      ])
    ).toBe("hello world")
  })

  it("walks markdown parts via the `md` field", () => {
    expect(extractPlainText([{ type: "markdown", md: "**bold**" }])).toBe("**bold**")
  })

  it("handles code blocks via `text` and falls back to `code`", () => {
    expect(extractPlainText([{ type: "code", text: "const x = 1", language: "ts" }])).toBe(
      "[ts] const x = 1"
    )
    expect(extractPlainText([{ type: "code", code: "echo hi" }])).toBe("echo hi")
  })

  it("includes an `[image]` marker so search hits image-only conversations", () => {
    expect(extractPlainText([{ type: "image" }])).toBe("[image]")
    expect(extractPlainText([{ type: "image", alt: "logo" }])).toBe("[image: logo]")
  })

  it("uses the A2UI plainTextMirror for surface parts", () => {
    expect(extractPlainText([{ type: "a2ui", plainTextMirror: "Approve | Reject" }])).toBe(
      "Approve | Reject"
    )
  })

  it("falls back to A2UI `text` when the renderer stashed the mirror there", () => {
    expect(extractPlainText([{ type: "a2ui", text: "legacy mirror" }])).toBe("legacy mirror")
  })

  it("skips unknown part types but keeps surrounding text", () => {
    expect(
      extractPlainText([
        { type: "text", text: "before" },
        { type: "future" },
        { type: "text", text: "after" },
      ])
    ).toBe("before after")
  })

  it("collapses repeated whitespace and trims edges", () => {
    expect(
      extractPlainText([
        { type: "text", text: "  spaced   out  " },
        { type: "text", text: "\nlines\n" },
      ])
    ).toBe("spaced out lines")
  })
})
