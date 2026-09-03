/**
 * @jest-environment node
 */
import { END_OF_LINE_CARET, highlightMentions, highlightMentionsWithCursor } from "./highlight"

describe("highlightMentions", () => {
  it("returns a single plain segment for a line with no tokens", () => {
    expect(highlightMentions("hello world")).toEqual([{ text: "hello world" }])
  })

  it("returns a single plain segment for an empty line", () => {
    expect(highlightMentions("")).toEqual([{ text: "" }])
  })

  it("splits a skill token out of surrounding text", () => {
    expect(highlightMentions("use @skill:cite please")).toEqual([
      { text: "use " },
      { text: "@skill:cite", kind: "skill" },
      { text: " please" },
    ])
  })

  it("tags agent and file tokens with their kind", () => {
    expect(highlightMentions("@agent:rev @file:src/a.ts")).toEqual([
      { text: "@agent:rev", kind: "agent" },
      { text: " " },
      { text: "@file:src/a.ts", kind: "file" },
    ])
  })

  it("does not treat a bare @path (no prefix) as a token", () => {
    expect(highlightMentions("@src/app.ts")).toEqual([{ text: "@src/app.ts" }])
  })

  it("handles a token at the very end with no trailing text", () => {
    expect(highlightMentions("run @skill:concise")).toEqual([
      { text: "run " },
      { text: "@skill:concise", kind: "skill" },
    ])
  })
})

describe("highlightMentionsWithCursor", () => {
  const line = "ask @agent:reviewer now"
  const at = (col: number) => highlightMentionsWithCursor(line, col, col + 1)

  it("keeps a token's colour on every fragment when the caret sits inside it", () => {
    // The whole point: the row under the cursor used to render unhighlighted,
    // so a token changed colour as the cursor moved onto and off its line.
    const segments = at(6)
    expect(segments).toEqual([
      { text: "ask " },
      { text: "@a", kind: "agent" },
      { text: "g", kind: "agent", cursor: true },
      { text: "ent:reviewer", kind: "agent" },
      { text: " now" },
    ])
  })

  it("marks exactly one run as the caret, wherever it sits", () => {
    for (let col = 0; col <= line.length + 2; col++) {
      const carets = highlightMentionsWithCursor(line, col, col + 1).filter((s) => s.cursor)
      expect(carets).toHaveLength(1)
    }
  })

  it("reproduces the line exactly, except for the end-of-line caret glyph", () => {
    for (let col = 0; col < line.length; col++) {
      expect(
        highlightMentionsWithCursor(line, col, col + 1)
          .map((s) => s.text)
          .join("")
      ).toBe(line)
    }
  })

  it("uses a block glyph past the last character, which Ink will not trim", () => {
    const end = highlightMentionsWithCursor(line, line.length, line.length + 1)
    expect(end[end.length - 1]).toEqual({ text: END_OF_LINE_CARET, cursor: true })
    expect(highlightMentionsWithCursor("", 0, 1)).toEqual([
      { text: END_OF_LINE_CARET, cursor: true },
    ])
  })

  it("covers a whole grapheme cluster, so a surrogate pair is not half-inverted", () => {
    // The caller passes the next grapheme boundary, which is two code units on
    // for an astral character. Inverting one half of a surrogate pair would
    // paint a replacement glyph.
    expect(highlightMentionsWithCursor("🚀 ship", 0, 2)[0]).toEqual({ text: "🚀", cursor: true })
    // A BMP wide character is one code unit, and still comes back whole.
    expect(highlightMentionsWithCursor("重构 x", 0, 1)[0]).toEqual({ text: "重", cursor: true })
  })

  it("never emits an empty run, which would render as a stray reset", () => {
    for (let col = 0; col <= line.length; col++) {
      for (const seg of highlightMentionsWithCursor(line, col, col + 1)) {
        expect(seg.text).not.toBe("")
      }
    }
  })
})
