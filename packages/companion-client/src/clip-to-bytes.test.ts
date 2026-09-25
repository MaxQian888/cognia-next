import { utf8ByteLength } from "./base64url"
import { clipToBytes } from "./clip-to-bytes"

/** Whether a string contains a surrogate that is not half of a pair. */
function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

describe("clipToBytes", () => {
  it("returns text that fits untouched", () => {
    expect(clipToBytes("hello", 5)).toEqual({ text: "hello", truncated: false })
    expect(clipToBytes("", 0)).toEqual({ text: "", truncated: false })
  })

  it("cuts ASCII at the byte ceiling exactly", () => {
    expect(clipToBytes("abcdef", 4)).toEqual({ text: "abcd", truncated: true })
  })

  it("never splits a multi-byte codepoint", () => {
    // Each of these is three bytes in UTF-8; a four-byte ceiling fits one.
    const clipped = clipToBytes("中文字", 4)
    expect(clipped).toEqual({ text: "中", truncated: true })
    expect(utf8ByteLength(clipped.text)).toBeLessThanOrEqual(4)
  })

  it("never leaves half of a surrogate pair behind", () => {
    // "a" (1 byte) + "😀" (4 bytes, two UTF-16 units). A ceiling of 3 lands
    // the code-unit search between the two halves of the emoji, which is the
    // cut the extension's old loop made and turned into U+FFFD on the wire.
    const clipped = clipToBytes("a😀b", 3)
    expect(clipped).toEqual({ text: "a", truncated: true })
    expect(hasLoneSurrogate(clipped.text)).toBe(false)
  })

  it("keeps a whole astral codepoint when it fits", () => {
    expect(clipToBytes("a😀b", 5)).toEqual({ text: "a😀", truncated: true })
  })

  it("stays within the ceiling and pair-safe across every cut of mixed text", () => {
    const value = "x😀中é😀yz😀"
    for (let limit = 0; limit <= utf8ByteLength(value); limit += 1) {
      const clipped = clipToBytes(value, limit)
      expect(utf8ByteLength(clipped.text)).toBeLessThanOrEqual(limit)
      expect(hasLoneSurrogate(clipped.text)).toBe(false)
      expect(value.startsWith(clipped.text)).toBe(true)
      expect(clipped.truncated).toBe(clipped.text.length < value.length)
    }
  })

  it("treats a nonsensical ceiling as zero rather than throwing", () => {
    expect(clipToBytes("abc", -1)).toEqual({ text: "", truncated: true })
    expect(clipToBytes("abc", Number.NaN)).toEqual({ text: "", truncated: true })
    expect(clipToBytes("abc", 2.9)).toEqual({ text: "ab", truncated: true })
  })

  it("is fast enough for a whole page of CJK text", () => {
    const page = "漢".repeat(200_000)
    const started = Date.now()
    const clipped = clipToBytes(page, 128 * 1024)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(utf8ByteLength(clipped.text)).toBeLessThanOrEqual(128 * 1024)
    expect(clipped.truncated).toBe(true)
  })
})
