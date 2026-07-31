import { md5Hex } from "./md5"

describe("md5Hex — RFC 1321 test vectors", () => {
  it('hashes ""', () => {
    expect(md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e")
  })

  it('hashes "a"', () => {
    expect(md5Hex("a")).toBe("0cc175b9c0f1b6a831c399e269772661")
  })

  it('hashes "abc"', () => {
    expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72")
  })

  it('hashes "message digest"', () => {
    expect(md5Hex("message digest")).toBe("f96b697d7cb7938d525a2f31aaf161d0")
  })

  it("hashes the lowercase alphabet", () => {
    expect(md5Hex("abcdefghijklmnopqrstuvwxyz")).toBe("c3fcd3d76192e4007dfb496cca67e13b")
  })

  it("hashes the alphanumeric vector", () => {
    expect(md5Hex("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")).toBe(
      "d174ab98d277d9f5a5611c2c9f419d9f"
    )
  })

  it("hashes the 80-digit vector (multi-block)", () => {
    expect(
      md5Hex("12345678901234567890123456789012345678901234567890123456789012345678901234567890")
    ).toBe("57edf4a22be3c955ac49da2e2107b67a")
  })

  it("handles the 56-byte padding boundary (padding spans two blocks)", () => {
    // 56 bytes leaves no room for the 8-byte length in the same block.
    expect(md5Hex("a".repeat(56))).toBe("3b0c8ac703f828b04c6c197006d17218")
  })

  it("accepts raw bytes and matches the string path", () => {
    const bytes = new TextEncoder().encode("abc")
    expect(md5Hex(bytes)).toBe(md5Hex("abc"))
  })

  it("hashes binary (non-UTF8) bytes", () => {
    const bytes = new Uint8Array(256)
    for (let i = 0; i < 256; i++) bytes[i] = i
    // Cross-checked with `printf` + `md5` (all byte values 0x00..0xff).
    expect(md5Hex(bytes)).toBe("e2c865db4162bed963bfaa9ef6ac18f0")
  })
})
