import { blankHtmlComments, maskInlineCode, maskMarkdown, normalizeNewlines } from "./markdown"

const lines = (text: string) => maskMarkdown(text).split("\n")

it("keeps every offset, so masked columns index the source", () => {
  const source = "a `b` c\n```\ncode\n```\n> q\n<!-- x\ny -->z"
  const masked = maskMarkdown(source)
  expect(masked.length).toBe(source.length)
  expect(masked.split("\n").map((line) => line.length)).toEqual(
    source.split("\n").map((line) => line.length)
  )
})

it("blanks fenced code of either fence character until a matching close", () => {
  expect(lines("```js\n@bot\n~~~\nstill\n````\nlive")).toEqual([
    "     ",
    "    ",
    "   ",
    "     ",
    "    ",
    "live",
  ])
  expect(lines("~~~\n@bot\n~~~\nlive")).toEqual(["   ", "    ", "   ", "live"])
  // An unclosed fence runs to the end, as GitHub renders it.
  expect(lines("```\n@bot")).toEqual(["   ", "    "])
  // A backtick in a backtick fence's info string makes it inline code, not a fence.
  expect(lines("``` a ` b\nlive")[1]).toBe("live")
})

it("blanks indented code only where it can start, never inside a paragraph", () => {
  expect(lines("text\n    @bot")).toEqual(["text", "    @bot"])
  expect(lines("text\n\n    @bot\n    more\n\nlive")).toEqual([
    "text",
    "",
    "        ",
    "        ",
    "",
    "live",
  ])
  expect(lines("\t@bot")[0]).toBe(" ".repeat(5))
})

it("blanks quotes and their lazy continuation until a blank line", () => {
  expect(lines("> @bot ask\n@bot lazy\n\n@bot live")).toEqual([
    "          ",
    "         ",
    "",
    "@bot live",
  ])
  expect(maskMarkdown("> @bot", { quotes: false })).toBe("> @bot")
})

it("blanks HTML comments, closed or not, across lines", () => {
  expect(blankHtmlComments("a<!-- b\nc -->d")).toBe("a      \n     d")
  expect(blankHtmlComments("a<!-- open")).toBe("a         ")
})

it("blanks inline code spans by matching run length, and leaves escapes and strays", () => {
  expect(maskInlineCode("x `@bot` y")).toBe("x        y")
  expect(maskInlineCode("``a ` b`` c")).toBe("          c")
  expect(maskInlineCode("a ` b")).toBe("a ` b")
  expect(maskInlineCode("\\`@bot`")).toBe("\\`@bot`")
})

it("normalizes CRLF and lone CR", () => {
  expect(normalizeNewlines("a\r\nb\rc")).toBe("a\nb\nc")
})
