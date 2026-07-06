import { detectKind, buildTextCandidate } from "./detect"

describe("detectKind", () => {
  it("classifies URLs vs text", () => {
    expect(detectKind("https://example.com/a")).toBe("url")
    expect(detectKind("  http://x.test ")).toBe("url")
    expect(detectKind("just some notes")).toBe("text")
    expect(detectKind("not a url with spaces .com")).toBe("text")
  })
})

describe("buildTextCandidate", () => {
  it("builds a url candidate with a fingerprint", async () => {
    const c = await buildTextCandidate("https://example.com/page", "Chrome")
    expect(c?.kind).toBe("url")
    expect(c?.sourceUrl).toBe("https://example.com/page")
    expect(c?.sourceApp).toBe("Chrome")
    expect(c?.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it("builds a text candidate", async () => {
    const c = await buildTextCandidate("a plain note")
    expect(c?.kind).toBe("text")
    expect(c?.sourceUrl).toBeUndefined()
  })

  it("returns null for empty text", async () => {
    expect(await buildTextCandidate("   ")).toBeNull()
  })

  it("produces stable fingerprints for identical text", async () => {
    const a = await buildTextCandidate("same text")
    const b = await buildTextCandidate("same text")
    expect(a?.fingerprint).toBe(b?.fingerprint)
  })
})
