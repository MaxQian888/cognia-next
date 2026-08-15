import {
  MAX_VIEWER_BYTES,
  exceedsUtf8Limit,
  extensionOf,
  sizeBucket,
  utf8ByteLength,
} from "./probe"

describe("extensionOf", () => {
  it("takes the last extension, lower-cased", () => {
    expect(extensionOf("a/b/notes.MD")).toBe("md")
    expect(extensionOf("archive.tar.gz")).toBe("gz")
  })

  it("treats a dotfile as a name, not an extension", () => {
    // `.gitignore` is called that; it is not a file of type "gitignore".
    expect(extensionOf(".gitignore")).toBe("")
    expect(extensionOf("nested/.env")).toBe("")
  })

  it("returns empty for a name with no extension at all", () => {
    expect(extensionOf("README")).toBe("")
    expect(extensionOf("src/Makefile")).toBe("")
    expect(extensionOf("")).toBe("")
  })
})

describe("exceedsUtf8Limit", () => {
  it("agrees with an exact encode on every branch of the fast path", () => {
    const cases = [
      "", // trivially under
      "plain ascii",
      "中文字符占三个字节", // 3 bytes per unit — the ceiling
      "🚀🚀🚀", // surrogate pairs: 2 units, 4 bytes
    ]
    for (const text of cases) {
      expect(exceedsUtf8Limit(text, 8)).toBe(utf8ByteLength(text) > 8)
      expect(exceedsUtf8Limit(text, 1_000)).toBe(utf8ByteLength(text) > 1_000)
    }
  })

  it("rejects on unit count alone once that already exceeds the limit", () => {
    // Every code unit costs at least one byte, so this needs no encode.
    expect(exceedsUtf8Limit("a".repeat(11), 10)).toBe(true)
  })

  it("accepts on the three-bytes-per-unit ceiling without encoding", () => {
    expect(exceedsUtf8Limit("a".repeat(3), 9)).toBe(false)
  })

  it("defaults to the viewer's own cap", () => {
    expect(exceedsUtf8Limit("a".repeat(MAX_VIEWER_BYTES))).toBe(false)
    expect(exceedsUtf8Limit("a".repeat(MAX_VIEWER_BYTES + 1))).toBe(true)
  })
})

describe("sizeBucket", () => {
  it("bands sizes instead of reporting a byte count", () => {
    // A byte count is a weak content fingerprint, so diagnostics get a band.
    expect(sizeBucket(0)).toBe("0")
    expect(sizeBucket(512)).toBe("<1k")
    expect(sizeBucket(5_000)).toBe("<10k")
    expect(sizeBucket(50_000)).toBe("<100k")
    expect(sizeBucket(500_000)).toBe("<1m")
    expect(sizeBucket(MAX_VIEWER_BYTES)).toBe("<2m")
    expect(sizeBucket(MAX_VIEWER_BYTES + 1)).toBe(">2m")
  })
})
