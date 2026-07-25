import { resolveClickTarget, tokenAtColumn } from "./click-target"

/** Only these paths "exist" for the resolver under test. */
const EXISTING = new Set(["src/app.ts", "lib/utils.ts", "README.md", "~/notes.md"])
const exists = (candidate: string) => EXISTING.has(candidate)

describe("tokenAtColumn", () => {
  it("returns the whitespace-delimited token under the column", () => {
    expect(tokenAtColumn("open src/app.ts now", 7)).toBe("src/app.ts")
  })

  it("returns null on whitespace and past the end of the line", () => {
    expect(tokenAtColumn("a b", 1)).toBeNull()
    expect(tokenAtColumn("ab", 9)).toBeNull()
  })

  it("strips the punctuation that usually wraps a path in prose", () => {
    expect(tokenAtColumn("(see src/app.ts:12)", 8)).toBe("src/app.ts:12")
    expect(tokenAtColumn('edited "lib/utils.ts",', 12)).toBe("lib/utils.ts")
  })

  it("maps display columns, not string indices, with wide glyphs present", () => {
    // 修改了 occupies columns 0-5; the path starts at column 6.
    expect(tokenAtColumn("修改了 src/app.ts", 9)).toBe("src/app.ts")
  })

  it("treats a wide glyph as a boundary so Chinese prose does not swallow a path", () => {
    // No separator — the shape this TUI actually produces when narrating in Chinese.
    expect(tokenAtColumn("修改了src/app.ts", 8)).toBe("src/app.ts")
  })

  it("returns null when the column lands on the wide glyph itself", () => {
    expect(tokenAtColumn("修改了src/app.ts", 2)).toBeNull()
  })
})

describe("resolveClickTarget", () => {
  it("opens a real file under the pointer", () => {
    expect(resolveClickTarget("edited src/app.ts today", 9, exists)).toEqual({
      kind: "file",
      path: "src/app.ts",
    })
  })

  it("carries the :line and :line:col suffix through", () => {
    expect(resolveClickTarget("src/app.ts:42", 2, exists)).toEqual({
      kind: "file",
      path: "src/app.ts",
      line: 42,
    })
    expect(resolveClickTarget("src/app.ts:42:7", 2, exists)).toEqual({
      kind: "file",
      path: "src/app.ts",
      line: 42,
      col: 7,
    })
  })

  it("recognises an extension-only filename", () => {
    expect(resolveClickTarget("see README.md", 6, exists)).toEqual({
      kind: "file",
      path: "README.md",
    })
  })

  it("falls back to the row when a path-shaped token does not exist", () => {
    expect(resolveClickTarget("  missing/file.ts  ", 4, exists)).toEqual({
      kind: "line",
      text: "missing/file.ts",
    })
  })

  it("copies a URL under the pointer rather than opening anything", () => {
    expect(resolveClickTarget("docs at https://example.com/x here", 12, exists)).toEqual({
      kind: "url",
      url: "https://example.com/x",
    })
  })

  it("copies the trimmed row when the token is ordinary prose", () => {
    expect(resolveClickTarget("  just some words  ", 8, exists)).toEqual({
      kind: "line",
      text: "just some words",
    })
  })

  it("copies the trimmed row when the click lands on whitespace", () => {
    expect(resolveClickTarget("  a b  ", 3, exists)).toEqual({ kind: "line", text: "a b" })
  })

  it("resolves to nothing on a blank row", () => {
    expect(resolveClickTarget("      ", 2, exists)).toEqual({ kind: "none" })
  })

  it("does not mistake a bare word for a filename", () => {
    expect(resolveClickTarget("hello world", 1, () => true)).toEqual({
      kind: "line",
      text: "hello world",
    })
  })
})
