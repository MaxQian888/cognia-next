import { isMouseSequence, parseMouseEvent } from "./mouse"

describe("parseMouseEvent", () => {
  it("decodes a wheel-up report (button 64)", () => {
    expect(parseMouseEvent("[<64;10;5M")).toEqual({ kind: "wheel", dir: "up" })
  })

  it("decodes a wheel-down report (button 65)", () => {
    expect(parseMouseEvent("[<65;10;5M")).toEqual({ kind: "wheel", dir: "down" })
  })

  it("decodes a wheel report that still carries the leading ESC", () => {
    expect(parseMouseEvent("\x1b[<64;1;1M")).toEqual({ kind: "wheel", dir: "up" })
  })

  it("keeps the wheel direction when modifier bits are OR-ed in", () => {
    // Ctrl+wheel-up = 64 | 16 = 80; Shift+wheel-down = 65 | 4 = 69.
    expect(parseMouseEvent("[<80;3;3M")).toEqual({ kind: "wheel", dir: "up" })
    expect(parseMouseEvent("[<69;3;3M")).toEqual({ kind: "wheel", dir: "down" })
  })

  it("decodes a left-button press as a click with 1-based col/row", () => {
    expect(parseMouseEvent("[<0;4;2M")).toEqual({ kind: "click", col: 4, row: 2 })
    // Modifier bits OR-ed in still classify as a click (button low bits 0).
    expect(parseMouseEvent("[<16;9;3M")).toEqual({ kind: "click", col: 9, row: 3 })
  })

  it("classifies releases, drags, and non-left buttons as 'other'", () => {
    expect(parseMouseEvent("[<0;4;2m")).toEqual({ kind: "other" }) // left release
    expect(parseMouseEvent("[<32;4;2M")).toEqual({ kind: "other" }) // drag/motion bit
    expect(parseMouseEvent("[<2;4;2M")).toEqual({ kind: "other" }) // right-button press
  })

  it("returns null for ordinary text and key sequences", () => {
    expect(parseMouseEvent("hello")).toBeNull()
    expect(parseMouseEvent("[A")).toBeNull() // a bare arrow CSI, not a mouse report
    expect(parseMouseEvent("[<64;10;5")).toBeNull() // missing final byte
    expect(parseMouseEvent("")).toBeNull()
  })
})

describe("isMouseSequence", () => {
  it("is true for any mouse report and false otherwise", () => {
    expect(isMouseSequence("[<64;10;5M")).toBe(true)
    expect(isMouseSequence("[<0;1;1m")).toBe(true)
    expect(isMouseSequence("a")).toBe(false)
    expect(isMouseSequence("[<64;10;5")).toBe(false)
  })
})
