import { encodeBase64, decodeBase64, encodeBase64Url, decodeBase64Url } from "./encoding"

const BYTES = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])

describe("base64", () => {
  it("round-trips arbitrary bytes", () => {
    expect(Array.from(decodeBase64(encodeBase64(BYTES)))).toEqual(Array.from(BYTES))
  })

  it("encodes the empty array to an empty string", () => {
    expect(encodeBase64(new Uint8Array([]))).toBe("")
    expect(Array.from(decodeBase64(""))).toEqual([])
  })
})

describe("base64url", () => {
  it("round-trips arbitrary bytes", () => {
    expect(Array.from(decodeBase64Url(encodeBase64Url(BYTES)))).toEqual(Array.from(BYTES))
  })

  it("is URL-safe and unpadded", () => {
    // 0xFB,0xFF,0xFE base64-encodes to "+//+" which must become "-__-" with no "=".
    const encoded = encodeBase64Url(new Uint8Array([0xfb, 0xff, 0xfe]))
    expect(encoded).not.toMatch(/[+/=]/)
  })

  it("decodes values that lost their padding", () => {
    // One byte → 2 base64 chars + "==" padding; the url variant drops the padding.
    const oneByte = new Uint8Array([42])
    const encoded = encodeBase64Url(oneByte)
    expect(encoded).not.toContain("=")
    expect(Array.from(decodeBase64Url(encoded))).toEqual([42])
  })
})
