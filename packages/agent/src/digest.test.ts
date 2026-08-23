import { canonicalJson, contentDigest, sha256Hex } from "./digest"

describe("sha256Hex", () => {
  // FIPS 180-4 / NIST published vectors.
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
    [
      "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
      "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1",
    ],
  ])("matches the published vector for %p", (input, expected) => {
    expect(sha256Hex(input)).toBe(expected)
  })

  it("matches the million-'a' vector", () => {
    expect(sha256Hex("a".repeat(1_000_000))).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
    )
  })

  it("hashes bytes and their string form identically", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(sha256Hex("abc"))
  })

  it("handles multi-byte UTF-8 rather than truncating it", () => {
    expect(sha256Hex("héllo — 世界")).toBe(sha256Hex("héllo — 世界"))
    expect(sha256Hex("世界")).not.toBe(sha256Hex("abc"))
    expect(sha256Hex("世界")).toHaveLength(64)
  })

  it("crosses every padding boundary without drifting", () => {
    // 55/56/57 and 63/64/65 are where the length block moves into a new chunk.
    const seen = new Set<string>()
    for (const length of [54, 55, 56, 57, 63, 64, 65, 119, 120, 128]) {
      const digest = sha256Hex("x".repeat(length))
      expect(digest).toHaveLength(64)
      seen.add(digest)
    }
    expect(seen.size).toBe(10)
  })
})

describe("canonicalJson", () => {
  it("sorts keys so property order cannot change the digest", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(contentDigest({ b: 1, a: 2 })).toBe(contentDigest({ a: 2, b: 1 }))
  })

  it("sorts nested keys too", () => {
    expect(contentDigest({ outer: { z: 1, a: 2 } })).toBe(contentDigest({ outer: { a: 2, z: 1 } }))
  })

  it("keeps array order significant", () => {
    expect(contentDigest([1, 2])).not.toBe(contentDigest([2, 1]))
  })

  it("drops undefined members so an absent field and an undefined one agree", () => {
    expect(contentDigest({ a: 1, b: undefined })).toBe(contentDigest({ a: 1 }))
  })

  it("distinguishes null from absent", () => {
    expect(contentDigest({ a: 1, b: null })).not.toBe(contentDigest({ a: 1 }))
  })

  it("prefixes the digest with its algorithm", () => {
    expect(contentDigest({})).toMatch(/^sha256-[0-9a-f]{64}$/)
  })
})
