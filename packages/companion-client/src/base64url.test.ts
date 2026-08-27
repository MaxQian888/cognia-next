import {
  base64UrlToBytes,
  base64UrlToText,
  bytesToBase64Url,
  textToBase64Url,
  utf8ByteLength,
} from "./base64url"

describe("base64url", () => {
  it("round-trips text through unpadded base64url", () => {
    for (const value of ["", "a", "ab", "abc", "hello world", '{"a":1}']) {
      expect(base64UrlToText(textToBase64Url(value))).toBe(value)
    }
  })

  it("never emits padding or the two url-unsafe characters", () => {
    // A length that forces padding in standard base64 ("a" → "YQ==").
    const encoded = textToBase64Url("a")
    expect(encoded).toBe("YQ")
    for (const value of ["a", "ab", "abc", "ÿþýü"]) {
      const out = textToBase64Url(value)
      expect(out).not.toMatch(/[+/=]/)
    }
  })

  it("round-trips non-ASCII without mangling it", () => {
    const value = "把这一页交给 Cognia — émoji 🎯"
    expect(base64UrlToText(textToBase64Url(value))).toBe(value)
  })

  it("round-trips raw bytes, including a signature-sized buffer", () => {
    const bytes = new Uint8Array(64)
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 7) % 256
    expect(Array.from(base64UrlToBytes(bytesToBase64Url(bytes)))).toEqual(Array.from(bytes))
  })

  it("encodes a payload larger than one chunk", () => {
    // The chunked `String.fromCharCode` path: a single spread of 100k bytes
    // would blow the argument limit on some engines.
    const bytes = new Uint8Array(200_000).fill(65)
    expect(base64UrlToBytes(bytesToBase64Url(bytes)).length).toBe(bytes.length)
  })

  it("counts UTF-8 bytes, not characters", () => {
    expect(utf8ByteLength("abc")).toBe(3)
    // The reason every limit in this contract is denominated in bytes: a CJK
    // page reaches a byte ceiling at roughly a third of the character count.
    expect(utf8ByteLength("交给")).toBe(6)
    expect(utf8ByteLength("🎯")).toBe(4)
  })
})
