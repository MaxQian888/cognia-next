import { detectTrigger, spliceToken } from "../composer-trigger"

describe("detectTrigger — slash mode", () => {
  it("matches a `/` at the start of input", () => {
    const t = detectTrigger("/cle", 4)
    expect(t).toEqual({
      kind: "slash",
      tokenStart: 0,
      tokenEnd: 4,
      query: "cle",
    })
  })

  it("matches `/` even with empty query", () => {
    const t = detectTrigger("/", 1)
    expect(t).toMatchObject({ kind: "slash", query: "" })
  })

  it("does NOT match `/` mid-line (file paths, URLs)", () => {
    expect(detectTrigger("read src/page.tsx", 17)).toBeNull()
    expect(detectTrigger("see /api/foo", 12)).toBeNull()
  })

  it("matches `/` at the start of a later line", () => {
    expect(detectTrigger("hi\n/help", 8)).toEqual({
      kind: "slash",
      tokenStart: 3,
      tokenEnd: 8,
      query: "help",
    })
  })

  it("ends the slash token at whitespace", () => {
    // Caret at end of "/clear" — query is full word.
    const t = detectTrigger("/clear now", 6)
    expect(t).toEqual({
      kind: "slash",
      tokenStart: 0,
      tokenEnd: 6,
      query: "clear",
    })
  })

  it("query is truncated to caret position so popover filters on partial input", () => {
    const t = detectTrigger("/clear now", 4)
    expect(t).toMatchObject({ kind: "slash", query: "cle" })
  })
})

describe("detectTrigger — file mode", () => {
  it("matches `@` after whitespace", () => {
    const t = detectTrigger("see @lib/uti", 12)
    expect(t).toEqual({
      kind: "file",
      tokenStart: 4,
      tokenEnd: 12,
      query: "lib/uti",
    })
  })

  it("matches `@` at the very start", () => {
    const t = detectTrigger("@app/page", 9)
    expect(t).toMatchObject({ kind: "file", query: "app/page" })
  })

  it("matches `@` with empty query", () => {
    const t = detectTrigger("hi @", 4)
    expect(t).toMatchObject({ kind: "file", query: "" })
  })

  it("does NOT match emails (`@` after non-whitespace)", () => {
    expect(detectTrigger("user@host.com", 13)).toBeNull()
  })

  it("returns null when caret is left of any `@`", () => {
    expect(detectTrigger("text @file", 3)).toBeNull()
  })
})

describe("detectTrigger — bash and memory modes", () => {
  it("matches `!` only at the start", () => {
    expect(detectTrigger("!ls -la", 7)).toMatchObject({
      kind: "bash",
      query: "ls -la",
    })
    expect(detectTrigger("hi !ls", 6)).toBeNull()
  })

  it("matches `#` only at the start", () => {
    expect(detectTrigger("#prefer 4-space tabs", 20)).toMatchObject({
      kind: "memory",
    })
    expect(detectTrigger("issue #123", 10)).toBeNull()
  })

  it("trigger covers the whole first line for bash/memory", () => {
    const t = detectTrigger("!cmd\nmore", 4)
    expect(t).toMatchObject({ kind: "bash", tokenEnd: 4 })
  })

  it("returns null when the caret is on a later line", () => {
    expect(detectTrigger("!cmd\nmore", 9)).toBeNull()
  })
})

describe("spliceToken", () => {
  it("replaces a slash token with the chosen command + trailing space", () => {
    const result = spliceToken("/cle", 0, 4, "/clear")
    expect(result.value).toBe("/clear ")
    expect(result.caret).toBe("/clear ".length)
  })

  it("keeps existing trailing whitespace if any", () => {
    const result = spliceToken("/cl x", 0, 3, "/clear")
    // Token ends at position 3 (just before " x"); we don't double-add space.
    expect(result.value).toBe("/clear x")
    expect(result.caret).toBe("/clear".length)
  })

  it("works mid-string for @-references", () => {
    const result = spliceToken("see @lib", 4, 8, "@lib/utils.ts")
    expect(result.value).toBe("see @lib/utils.ts ")
  })
})
