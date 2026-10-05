import {
  bytesEqual,
  concatBytes,
  fromBase64Url,
  fromBase64UrlExact,
  toBase64Url,
  utf8,
} from "./bytes"

describe("bytes", () => {
  it("round-trips base64url without padding for every length", () => {
    for (let length = 0; length < 40; length++) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + length) & 0xff)
      const text = toBase64Url(bytes)
      expect(text).not.toMatch(/[=+/]/)
      expect(text).toBe(Buffer.from(bytes).toString("base64url"))
      expect(fromBase64Url(text)).toEqual(bytes)
    }
  })

  it("refuses padding, foreign characters and non-canonical trailing bits", () => {
    expect(() => fromBase64Url("AA==")).toThrow()
    expect(() => fromBase64Url("A+A")).toThrow()
    expect(() => fromBase64Url("A")).toThrow("length")
    // "AB" encodes one byte with four leftover bits that must be zero.
    expect(() => fromBase64Url("AB")).toThrow("non-canonical")
    expect(fromBase64Url("AA")).toEqual(new Uint8Array([0]))
  })

  it("requires an exact decoded length", () => {
    expect(() => fromBase64UrlExact(toBase64Url(new Uint8Array(31)), 32, "x")).toThrow("32 bytes")
    expect(() => fromBase64UrlExact(5, 32, "x")).toThrow("base64url string")
  })

  it("compares and joins bytes", () => {
    expect(bytesEqual(utf8("ab"), utf8("ab"))).toBe(true)
    expect(bytesEqual(utf8("ab"), utf8("ac"))).toBe(false)
    expect(bytesEqual(utf8("ab"), utf8("abc"))).toBe(false)
    expect(concatBytes(utf8("a"), new Uint8Array(), utf8("bc"))).toEqual(utf8("abc"))
  })
})
