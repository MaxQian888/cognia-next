import { parseJsonc, tryParseJsonc } from "./index"

describe("parseJsonc", () => {
  it("parses plain JSON identically to JSON.parse", () => {
    expect(parseJsonc('{ "a": 1, "b": [1, 2, 3], "c": { "d": null } }')).toEqual({
      a: 1,
      b: [1, 2, 3],
      c: { d: null },
    })
  })

  it("accepts line and block comments", () => {
    const text = `// header
{
  /* block */
  "a": 1, // trailing
  "b": 2
}`
    expect(parseJsonc(text)).toEqual({ a: 1, b: 2 })
  })

  it("accepts trailing commas in objects and arrays", () => {
    expect(parseJsonc('{ "a": 1, "b": [1, 2, 3,], }')).toEqual({ a: 1, b: [1, 2, 3] })
  })

  it("preserves comment-like text and comma-brace sequences inside strings", () => {
    expect(
      parseJsonc(
        '{ "cmd": "echo a,}", "url": "https://x.dev/a,b]", "note": "// not a comment /* nope */" }'
      )
    ).toEqual({
      cmd: "echo a,}",
      url: "https://x.dev/a,b]",
      note: "// not a comment /* nope */",
    })
  })

  it("handles escaped quotes inside strings", () => {
    expect(parseJsonc('{ "a": "he said \\"hi\\"" }')).toEqual({ a: 'he said "hi"' })
  })

  it("throws a SyntaxError naming the first problem on malformed input", () => {
    expect(() => parseJsonc("{ not json")).toThrow(SyntaxError)
    expect(() => parseJsonc("{ not json")).toThrow(/at offset \d+/)
    expect(() => parseJsonc("[1,2,")).toThrow(SyntaxError)
  })

  it("rejects single-quoted strings, which JSONC does not allow", () => {
    expect(() => parseJsonc("{ 'a': 1 }")).toThrow(SyntaxError)
  })

  it("rejects empty and comment-only documents", () => {
    for (const text of ["", "   ", "// only a comment", "/* only a block */"]) {
      expect(() => parseJsonc(text)).toThrow(SyntaxError)
    }
  })

  it("parses top-level primitives", () => {
    expect(parseJsonc("42")).toBe(42)
    expect(parseJsonc('"str"')).toBe("str")
    expect(parseJsonc("null")).toBeNull()
  })
})

describe("tryParseJsonc", () => {
  it("returns the value on valid JSONC", () => {
    expect(tryParseJsonc('{ "a": 1, // c\n}')).toEqual({ a: 1 })
  })

  it("returns undefined on any syntax error instead of throwing", () => {
    for (const text of ["", "{ not json", "[1,2,", "{ 'a': 1 }", '{ "a": "x\\']) {
      expect(tryParseJsonc(text)).toBeUndefined()
    }
  })

  it("does not return jsonc-parser's recovered partial value on error", () => {
    // `{ bad` recovers to `{}` inside jsonc-parser; callers get undefined.
    expect(tryParseJsonc("{ bad")).toBeUndefined()
  })
})
