import { screenColToBufferCol, clickToCursor } from "./mouse-cursor"

describe("screenColToBufferCol", () => {
  it("maps ASCII columns 1:1", () => {
    expect(screenColToBufferCol("hello", 0)).toBe(0)
    expect(screenColToBufferCol("hello", 3)).toBe(3)
    expect(screenColToBufferCol("hello", 99)).toBe(5) // past the end clamps
  })

  it("clamps a negative/zero screen column to the start", () => {
    expect(screenColToBufferCol("hi", -4)).toBe(0)
  })

  it("treats CJK glyphs as 2 cells and returns a UTF-16 index", () => {
    // "a中b": a(1) 中(2) b(1). Columns: a@0, 中@1-2, b@3.
    expect(screenColToBufferCol("a中b", 0)).toBe(0) // before a
    expect(screenColToBufferCol("a中b", 1)).toBe(1) // before 中
    expect(screenColToBufferCol("a中b", 2)).toBe(2) // right half of 中 → after it (index 2)
    expect(screenColToBufferCol("a中b", 3)).toBe(2) // before b
    expect(screenColToBufferCol("a中b", 4)).toBe(3) // after b
  })

  it("counts an astral glyph as its UTF-16 length", () => {
    // "🎉x": 🎉 is width 2 and 2 UTF-16 units; x at index 2.
    expect(screenColToBufferCol("🎉x", 2)).toBe(2) // before x
    expect(screenColToBufferCol("🎉x", 3)).toBe(3) // after x
  })

  it("never places the cursor inside a grapheme cluster", () => {
    expect(screenColToBufferCol("👩‍💻x", 0)).toBe(0)
    expect(screenColToBufferCol("👩‍💻x", 1)).toBe(5)
    expect(screenColToBufferCol("👩‍💻x", 2)).toBe(5)
    expect(screenColToBufferCol("e\u0301x", 1)).toBe(2)
  })
})

describe("clickToCursor", () => {
  const base = { boxTop: 5, boxLeft: 2, promptWidth: 2, lines: ["hello", "world"] }

  it("maps a click on the first text line", () => {
    // boxLeft 2 + prompt 2 = text starts at col 4; click col 6 → text col 2.
    expect(clickToCursor({ ...base, clickRow: 5, clickCol: 6 })).toEqual({ row: 0, col: 2 })
  })

  it("maps a click on a lower line", () => {
    expect(clickToCursor({ ...base, clickRow: 6, clickCol: 4 })).toEqual({ row: 1, col: 0 })
  })

  it("clamps a click left of the text to column 0", () => {
    expect(clickToCursor({ ...base, clickRow: 5, clickCol: 0 })).toEqual({ row: 0, col: 0 })
  })

  it("returns null for a click above or below the text rows", () => {
    expect(clickToCursor({ ...base, clickRow: 4, clickCol: 6 })).toBeNull()
    expect(clickToCursor({ ...base, clickRow: 7, clickCol: 6 })).toBeNull()
  })
})
