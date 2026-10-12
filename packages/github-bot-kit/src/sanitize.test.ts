import { sanitizeControlChars } from "./sanitize"

// Build control chars at runtime so no raw control byte lives in the source file.
const ESC = String.fromCharCode(0x1b)
const CSI = String.fromCharCode(0x9b)
const BEL = String.fromCharCode(0x07)
const NUL = String.fromCharCode(0x00)
const DEL = String.fromCharCode(0x7f)
const C1 = String.fromCharCode(0x85)

describe("sanitizeControlChars", () => {
  it("returns empty input unchanged", () => {
    expect(sanitizeControlChars("")).toBe("")
  })

  it("preserves tab, newline, and carriage return", () => {
    expect(sanitizeControlChars("a\tb\nc\r\nd")).toBe("a\tb\nc\r\nd")
  })

  it("strips a CSI color escape sequence", () => {
    const input = `${ESC}[31mred${ESC}[0m text`
    expect(sanitizeControlChars(input)).toBe("red text")
  })

  it("strips a single-byte CSI introducer sequence", () => {
    const input = `${CSI}1;2Hmoved`
    expect(sanitizeControlChars(input)).toBe("moved")
  })

  it("strips an OSC sequence terminated by BEL", () => {
    const input = `${ESC}]0;window title${BEL}body`
    expect(sanitizeControlChars(input)).toBe("body")
  })

  it("drops other C0 control chars, DEL, and C1 range", () => {
    const input = `a${NUL}b${DEL}c${C1}de`
    expect(sanitizeControlChars(input)).toBe("abcde")
  })

  it("leaves ordinary unicode text intact", () => {
    expect(sanitizeControlChars("héllo — 世界 ✅")).toBe("héllo — 世界 ✅")
  })

  it("removes a bare BEL that is not part of an OSC sequence", () => {
    expect(sanitizeControlChars(`ding${BEL}`)).toBe("ding")
  })
})
