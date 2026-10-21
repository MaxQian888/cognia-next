import { fnv1a, textFingerprint } from "./hash"

describe("hash", () => {
  it("is stable, hex and sensitive to content", () => {
    expect(fnv1a("abc")).toBe(fnv1a("abc"))
    expect(fnv1a("abc")).toMatch(/^[0-9a-f]{8}$/)
    expect(fnv1a("abc")).not.toBe(fnv1a("abd"))
    expect(fnv1a("")).toBe("811c9dc5")
  })

  it("fingerprints with two hashes", () => {
    expect(textFingerprint("x")).toHaveLength(16)
    expect(textFingerprint("x")).not.toBe(textFingerprint("y"))
  })
})
