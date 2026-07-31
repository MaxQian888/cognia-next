import { isMouseSequence, parseMouseEvent } from "./mouse"

/** No modifier keys held — the common case for the button reports below. */
const NO_MODS = { ctrl: false, alt: false, shift: false }

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
    expect(parseMouseEvent("[<0;4;2M")).toEqual({ kind: "click", col: 4, row: 2, mods: NO_MODS })
  })

  it("decodes the modifier bits held during a click", () => {
    // shift = 4, alt = 8, ctrl = 16.
    expect(parseMouseEvent("[<16;9;3M")).toEqual({
      kind: "click",
      col: 9,
      row: 3,
      mods: { ctrl: true, alt: false, shift: false },
    })
    expect(parseMouseEvent("[<12;9;3M")).toEqual({
      kind: "click",
      col: 9,
      row: 3,
      mods: { ctrl: false, alt: true, shift: true },
    })
  })

  it("decodes a held-button motion report as a drag", () => {
    // 32 = motion bit + left button.
    expect(parseMouseEvent("[<32;7;4M")).toEqual({ kind: "drag", col: 7, row: 4, mods: NO_MODS })
  })

  it("decodes any release as a release, whichever button code the terminal sends", () => {
    expect(parseMouseEvent("[<0;4;2m")).toEqual({ kind: "release", col: 4, row: 2, mods: NO_MODS })
    // Some terminals report 3 ("no button") on release instead of the button.
    expect(parseMouseEvent("[<3;4;2m")).toEqual({ kind: "release", col: 4, row: 2, mods: NO_MODS })
  })

  it("classifies non-left presses and non-left drags as 'other'", () => {
    expect(parseMouseEvent("[<2;4;2M")).toEqual({ kind: "other" }) // right-button press
    expect(parseMouseEvent("[<34;4;2M")).toEqual({ kind: "other" }) // right-button drag
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
