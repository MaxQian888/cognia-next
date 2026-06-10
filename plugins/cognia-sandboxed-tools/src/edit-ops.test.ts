import { applyInsert, applyStrReplace, EditOpError, sliceViewRange } from "./edit-ops"

describe("applyStrReplace", () => {
  it("replaces a unique occurrence", () => {
    expect(applyStrReplace("hello world", "world", "there")).toBe("hello there")
  })

  it("replaces all occurrences when replaceAll is set", () => {
    expect(applyStrReplace("a.a.a", "a", "b", true)).toBe("b.b.b")
  })

  it("throws when oldString is empty", () => {
    expect(() => applyStrReplace("x", "", "y")).toThrow(EditOpError)
  })

  it("throws when oldString is not found", () => {
    expect(() => applyStrReplace("hello", "zzz", "y")).toThrow(/not found/)
  })

  it("throws when oldString is ambiguous without replaceAll", () => {
    expect(() => applyStrReplace("a.a", "a", "b")).toThrow(/not unique/)
  })

  it("handles multi-line replacement", () => {
    expect(applyStrReplace("line1\nline2\nline3", "line2\n", "")).toBe("line1\nline3")
  })

  it("preserves content around the match", () => {
    expect(applyStrReplace("const x = 1", "1", "2")).toBe("const x = 2")
  })
})

describe("applyInsert", () => {
  it("inserts after the given line", () => {
    expect(applyInsert("a\nb\nc", 1, "X")).toBe("a\nX\nb\nc")
  })

  it("inserts at the start when line is 0", () => {
    expect(applyInsert("a\nb", 0, "X")).toBe("X\na\nb")
  })

  it("inserts at the end", () => {
    expect(applyInsert("a\nb", 2, "X")).toBe("a\nb\nX")
  })

  it("strips a trailing newline from the inserted block", () => {
    expect(applyInsert("a\nb", 1, "X\n")).toBe("a\nX\nb")
  })

  it("inserts a multi-line block", () => {
    expect(applyInsert("a\nb", 1, "X\nY")).toBe("a\nX\nY\nb")
  })

  it("handles an empty file", () => {
    expect(applyInsert("", 0, "X")).toBe("X")
  })

  it("throws on negative line", () => {
    expect(() => applyInsert("a", -1, "X")).toThrow(EditOpError)
  })

  it("throws when line is beyond end of file", () => {
    expect(() => applyInsert("a\nb", 5, "X")).toThrow(/beyond end/)
  })
})

describe("sliceViewRange", () => {
  it("slices an inclusive 1-based range", () => {
    expect(sliceViewRange("a\nb\nc\nd", 2, 3)).toBe("b\nc")
  })

  it("clamps the start to 1", () => {
    expect(sliceViewRange("a\nb", 0, 1)).toBe("a")
  })

  it("treats a negative end as end-of-file", () => {
    expect(sliceViewRange("a\nb\nc", 2, -1)).toBe("b\nc")
  })

  it("clamps the end to the last line", () => {
    expect(sliceViewRange("a\nb", 1, 99)).toBe("a\nb")
  })
})
