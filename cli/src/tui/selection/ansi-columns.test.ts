import {
  highlightColumns,
  isControlOnly,
  sliceColumns,
  stripAnsi,
  stripLeadingCursorControls,
  stripTrailingCursorControls,
} from "./ansi-columns"

const RED = "\x1b[31m"
const RESET = "\x1b[0m"
const REVERSE_ON = "\x1b[7m"
const REVERSE_OFF = "\x1b[27m"

describe("stripAnsi", () => {
  it("removes SGR colour sequences", () => {
    expect(stripAnsi(`${RED}hello${RESET} world`)).toBe("hello world")
  })

  it("removes OSC sequences terminated by BEL or ST", () => {
    expect(stripAnsi("\x1b]0;a title\x07text")).toBe("text")
    expect(stripAnsi("\x1b]52;c;aGk=\x1b\\text")).toBe("text")
  })

  it("removes cursor moves, erases, and bare two-byte escapes", () => {
    expect(stripAnsi("\x1b[2K\x1b[1;1Hbody\x1b7\x1b8")).toBe("body")
  })

  it("leaves plain text untouched", () => {
    expect(stripAnsi("nothing to strip")).toBe("nothing to strip")
  })
})

describe("isControlOnly", () => {
  it("is true for the terminal chrome the App writes to the same stream", () => {
    expect(isControlOnly("\x1b[?1000h\x1b[?1006h")).toBe(true) // mouse tracking
    expect(isControlOnly("\x1b[?1049h\x1b[2J\x1b[3J\x1b[H")).toBe(true) // alt screen
    expect(isControlOnly("\x1b]52;c;aGVsbG8=\x07")).toBe(true) // OSC 52 copy
    expect(isControlOnly("\x1b[?2026h")).toBe(true) // synchronized update
  })

  it("is false once a single displayable character is present", () => {
    expect(isControlOnly(`${RED}x${RESET}`)).toBe(false)
  })

  it("treats bare newlines as control-only (no displayable content)", () => {
    expect(isControlOnly("\r\n")).toBe(true)
  })
})

describe("stripLeadingCursorControls", () => {
  it("drops log-update's leading erase/rewind run", () => {
    expect(stripLeadingCursorControls("\x1b[2K\x1b[1A\x1b[2K\x1b[Gframe")).toBe("frame")
  })

  it("keeps a leading SGR colour — that belongs to the frame", () => {
    expect(stripLeadingCursorControls(`${RED}frame`)).toBe(`${RED}frame`)
  })

  it("stops at the first non-control byte", () => {
    expect(stripLeadingCursorControls("\x1b[2Ka\x1b[2Kb")).toBe("a\x1b[2Kb")
  })

  it("drops Ink's hide-cursor + return-to-bottom prefix", () => {
    // `CSI ?25l` + cursorDown + cursorTo(0) — emitted when a component parked
    // Ink's cursor on the previous frame.
    expect(stripLeadingCursorControls("\x1b[?25l\x1b[2B\x1b[1Gframe")).toBe("frame")
  })
})

describe("stripTrailingCursorControls", () => {
  it("drops the cursor-reposition suffix Ink appends after a frame", () => {
    expect(stripTrailingCursorControls("frame\x1b[3A\x1b[5G\x1b[?25h")).toBe("frame")
  })

  it("leaves a frame with no suffix untouched", () => {
    expect(stripTrailingCursorControls("frame")).toBe("frame")
  })

  it("never eats a trailing SGR reset — that closes the row's colour", () => {
    expect(stripTrailingCursorControls("frame\x1b[0m")).toBe("frame\x1b[0m")
  })
})

describe("sliceColumns", () => {
  it("slices plain text by display column, end-exclusive", () => {
    expect(sliceColumns("hello world", 6, 11)).toBe("world")
  })

  it("skips escape sequences when counting columns", () => {
    expect(sliceColumns(`${RED}hello${RESET} world`, 0, 5)).toBe("hello")
  })

  it("counts a wide CJK glyph as two columns and never splits it", () => {
    // 中 occupies columns 0-1, 文 columns 2-3, "x" column 4.
    expect(sliceColumns("中文x", 0, 2)).toBe("中")
    expect(sliceColumns("中文x", 2, 5)).toBe("文x")
    // A range starting mid-glyph still takes the glyph whole.
    expect(sliceColumns("中文x", 1, 4)).toBe("文")
  })

  it("returns empty for an inverted or empty range", () => {
    expect(sliceColumns("hello", 3, 3)).toBe("")
    expect(sliceColumns("hello", 4, 2)).toBe("")
  })

  it("does not pad past the end of the line", () => {
    expect(sliceColumns("ab", 0, 10)).toBe("ab")
  })
})

describe("highlightColumns", () => {
  it("wraps the requested columns in reverse video", () => {
    expect(highlightColumns("hello", 1, 3)).toBe(`h${REVERSE_ON}el${REVERSE_OFF}lo`)
  })

  it("preserves styling outside the span", () => {
    const out = highlightColumns(`${RED}hello${RESET}`, 0, 2)
    expect(stripAnsi(out)).toBe("hello")
    expect(out.startsWith(`${RED}${REVERSE_ON}he${REVERSE_OFF}`)).toBe(true)
  })

  it("re-asserts reverse video after an escape inside the span", () => {
    // Ink closes a colour with `0m`, which would also clear the reverse video.
    const out = highlightColumns(`ab${RESET}cd`, 0, 4)
    expect(out).toContain(`${RESET}${REVERSE_ON}`)
    expect(stripAnsi(out)).toBe("abcd")
  })

  it("pads a short line so a multi-row selection keeps a straight edge", () => {
    expect(highlightColumns("ab", 0, 5)).toBe(`${REVERSE_ON}ab   ${REVERSE_OFF}`)
  })

  it("leaves the gap unstyled when the span starts past the last glyph", () => {
    expect(highlightColumns("ab", 4, 6)).toBe(`ab  ${REVERSE_ON}  ${REVERSE_OFF}`)
  })

  it("returns the line untouched for an empty range", () => {
    expect(highlightColumns("hello", 2, 2)).toBe("hello")
  })

  it("aligns the span to display columns with wide glyphs present", () => {
    // 中 spans columns 0-1, so highlighting [2,3) must start at 文.
    const out = highlightColumns("中文", 2, 4)
    expect(out).toBe(`中${REVERSE_ON}文${REVERSE_OFF}`)
  })
})
